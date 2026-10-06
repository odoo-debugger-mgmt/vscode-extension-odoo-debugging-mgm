"""Check that an inheriting view's xpath locators actually resolve.

This exists because Odoo's own view composition is *lenient*: as of 19.0,
`get_view()` on a parent whose child carries an `<xpath expr="...">` that
matches nothing succeeds anyway — it logs and silently drops the spec.
Verified directly against a live 19.0 database. So "the view activates"
is not evidence the view works; the patch can be quietly doing nothing,
which is exactly what a version upgrade tends to cause (the field or
node an xpath aimed at got renamed or removed).

Checking the locators against the tree they apply to is what actually
answers the question. Pure lxml, no database access — callers supply
both archs.

Ported from odoo-manager (odoo_manager/xpath_check.py) for the Odoo DevTools
View Doctor, which loads it inside the database's `odoo-bin shell`. The one
addition: each locator says where it is in the checked text - `line`, lxml's
sourceline (the line its start tag *ends* on), and `element`, its index among
the child arch's elements in document order - so the editor can put the
result on the right characters even when several locators share a line.
"""

from lxml import etree

ID_ATTRS = ("name", "id", "string", "t-name")


def _q(v):
    return "'%s'" % v if "'" not in v else '"%s"' % v


def _candidates(node, tag):
    """Shorter locators for `node`, most readable first."""
    out = []
    for attr in ID_ATTRS:
        if node.get(attr):
            out.append("//%s[@%s=%s]" % (tag, attr, _q(node.get(attr))))
    for anc in node.iterancestors():
        if not isinstance(anc.tag, str):
            continue
        for attr in ID_ATTRS:
            if not anc.get(attr):
                continue
            anchor = "//%s[@%s=%s]" % (anc.tag, attr, _q(anc.get(attr)))
            for sep in ("//", "/"):
                out.append("%s%s%s" % (anchor, sep, tag))
                for a2 in ID_ATTRS:
                    if node.get(a2):
                        out.append("%s%s%s[@%s=%s]" % (anchor, sep, tag, a2, _q(node.get(a2))))
    seen, uniq = set(), []
    for c in out:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def _direct_locator_expr(node):
    """The locator a direct (non-`<xpath>`) inheritance directive implies:
    `<field name="x" position="...">` means "the `field` with
    `name=x`" — the same rule Odoo's own view-inheritance code uses to
    find the node a patch without a wrapping `<xpath>` applies to. None
    when `node` has no usable identifying attribute at all."""
    tag = node.tag
    if not isinstance(tag, str):
        return None
    for attr in ID_ATTRS:
        if node.get(attr):
            return "//%s[@%s=%s]" % (tag, attr, _q(node.get(attr)))
    return None


def _direct_locator_nodes(child):
    """Every direct-inheritance-directive node anywhere in `child`'s
    tree: carries a `position` attribute and isn't itself an `<xpath>`
    (those are matched separately, by `expr`). `position` isn't used in
    an Odoo view arch for anything other than an inheritance directive,
    so this is safe to look for anywhere in the tree, not just at the
    top level — a real arch nests these under a wrapping `<data>` as
    soon as there's more than one directive."""
    return [
        n for n in child.iter()
        if isinstance(n.tag, str) and n.tag != "xpath" and n.get("position") is not None
    ]


def _resolve(node, expr, parent, kind, element):
    """Resolve one locator (`expr`, from `node`) against `parent`,
    classifying it `ok`/`dead`/`ambiguous`/`invalid` and, when it
    resolves uniquely, offering shorter equivalents. Shared by both
    `<xpath expr=…>` and direct-locator directives — `kind` (`"xpath"`
    or `"direct"`) is the only thing that tells the two apart in the
    result, so a caller can filter or weight them differently without
    the resolution logic itself knowing or caring which form it's
    looking at."""
    entry = {
        "kind": kind,
        "expr": expr,
        "position": node.get("position") or "inside",
        "length": len(expr),
        "line": node.sourceline,
        "element": element,
    }
    try:
        hits = parent.xpath(expr)
    except etree.XPathEvalError as e:
        entry.update(matches=None, status="invalid", detail=str(e))
        return entry

    entry["matches"] = len(hits)
    if not hits:
        entry["status"] = "dead"
    elif len(hits) > 1:
        entry["status"] = "ambiguous"
    else:
        entry["status"] = "ok"

    if hits:
        target = hits[0]
        tag = target.tag if isinstance(target.tag, str) else None
        shorter = []
        if tag:
            for cand in _candidates(target, tag):
                if len(cand) >= len(expr):
                    continue
                try:
                    got = parent.xpath(cand)
                except etree.XPathEvalError:
                    continue
                if len(got) == 1 and got[0] is target:
                    shorter.append(cand)
        entry["shorter"] = sorted(shorter, key=len)[:3]
    return entry


def check(child_arch, parent_arch):
    """Resolve every inheritance locator in `child_arch` against
    `parent_arch` — both `<xpath expr=…>` and the direct-locator form
    (`<field name="x" position="...">` etc. with no wrapping `<xpath>`),
    confirmed to be the *majority* form in real Studio/custom-code view
    patches, not an edge case.

    Returns one entry per locator (tagged `"kind": "xpath"` or
    `"kind": "direct"`) with its match count and, when the locator is
    long but resolves uniquely, shorter equivalents that select the
    very same node.

    `matches: 0` is a dead locator — the patch silently does nothing.
    `matches: >1` is ambiguous: Odoo applies the patch to the first hit,
    so it works by luck and can silently retarget when the parent view
    changes. A frequent cause is Studio's `//form[1]/...` prefix, since
    `form[1]` means "any form that is the first form child of its
    parent", not "the first form in the document" — inline one2many
    subviews match it too.
    """
    try:
        child = etree.fromstring(child_arch.encode())
    except etree.XMLSyntaxError as e:
        return {"error": "child arch is not valid XML: %s" % e}
    try:
        parent = etree.fromstring(parent_arch.encode())
    except etree.XMLSyntaxError as e:
        return {"error": "parent arch is not valid XML: %s" % e}

    # Comments and processing instructions are nodes too, but not elements:
    # the editor counts start tags, so they are left out of the count.
    elements = {
        node: index
        for index, node in enumerate(n for n in child.iter() if isinstance(n.tag, str))
    }

    results = []
    for node in child.iter("xpath"):
        expr = node.get("expr")
        if not expr:
            continue
        results.append(_resolve(node, expr, parent, kind="xpath", element=elements[node]))

    for node in _direct_locator_nodes(child):
        expr = _direct_locator_expr(node)
        if expr is None:
            continue
        results.append(_resolve(node, expr, parent, kind="direct", element=elements[node]))

    counts = {k: sum(1 for r in results if r.get("status") == k) for k in ("ok", "dead", "ambiguous", "invalid")}
    return {"locators": results, "summary": counts, "healthy": counts["dead"] == 0 and counts["invalid"] == 0}
