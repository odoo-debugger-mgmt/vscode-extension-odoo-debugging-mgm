"""Port of odoo-manager's tests/test_xpath_check.py (13 cases), plus where
each locator is (line, element) and the shorter equivalents.

Run by src/test/xpathCheck.test.ts as `python test_xpath_check.py <scripts
folder>`; prints one JSON object, test name -> null (passed) or the failure.
The two "pilot" cases read a client checkout in odoo-manager; here they use
inline archs that reproduce the same case.
"""
import json
import os
import sys
import traceback

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', '..', 'resources', 'scripts'))

import xpath_check as xc  # noqa: E402


# --- <xpath expr=…> ---------------------------------------------------------

def test_xpath_ok():
    child = '<xpath expr="//field[@name=\'x\']" position="after"><field name="y"/></xpath>'
    parent = '<form><field name="x"/></form>'
    result = xc.check(child, parent)
    assert result["summary"] == {"ok": 1, "dead": 0, "ambiguous": 0, "invalid": 0}
    assert result["healthy"] is True
    assert result["locators"][0]["kind"] == "xpath"


def test_xpath_dead():
    child = '<xpath expr="//field[@name=\'missing\']" position="after"><field name="y"/></xpath>'
    parent = '<form><field name="x"/></form>'
    result = xc.check(child, parent)
    assert result["summary"]["dead"] == 1
    assert result["healthy"] is False


def test_xpath_ambiguous():
    child = '<xpath expr="//field" position="after"><field name="y"/></xpath>'
    parent = '<form><field name="x"/><field name="z"/></form>'
    result = xc.check(child, parent)
    assert result["summary"]["ambiguous"] == 1


def test_xpath_invalid():
    child = '<xpath expr="//field[" position="after"><field name="y"/></xpath>'
    parent = "<form/>"
    result = xc.check(child, parent)
    assert result["summary"]["invalid"] == 1
    assert result["healthy"] is False


def test_malformed_child_arch_returns_error():
    result = xc.check("<not-closed>", "<form/>")
    assert "error" in result


def test_malformed_parent_arch_returns_error():
    result = xc.check('<xpath expr="//x" position="after"/>', "<not-closed>")
    assert "error" in result


# --- direct-locator form ----------------------------------------------------

def test_direct_locator_ok():
    child = '<field name="pricelist_id" position="before"><field name="x"/></field>'
    parent = '<form><field name="pricelist_id"/></form>'
    result = xc.check(child, parent)
    assert result["summary"] == {"ok": 1, "dead": 0, "ambiguous": 0, "invalid": 0}
    assert result["locators"][0]["kind"] == "direct"
    assert result["locators"][0]["expr"] == "//field[@name='pricelist_id']"


def test_direct_locator_dead():
    child = '<group name="not_there" position="inside"><field name="x"/></group>'
    parent = "<form><group name=\"group_general\"/></form>"
    result = xc.check(child, parent)
    assert result["summary"]["dead"] == 1


def test_direct_locator_nested_under_data_wrapper():
    child = (
        "<data>"
        '<field name="a" position="before"><field name="new1"/></field>'
        '<field name="b" position="after"><field name="new2"/></field>'
        "</data>"
    )
    parent = '<form><field name="a"/><field name="b"/></form>'
    result = xc.check(child, parent)
    assert result["summary"] == {"ok": 2, "dead": 0, "ambiguous": 0, "invalid": 0}
    assert {loc["kind"] for loc in result["locators"]} == {"direct"}


def test_mixed_xpath_and_direct_locators_both_checked():
    child = (
        "<data>"
        '<xpath expr="//field[@name=\'a\']" position="after"><field name="new1"/></xpath>'
        '<field name="b" position="before"><field name="new2"/></field>'
        "</data>"
    )
    parent = '<form><field name="a"/><field name="b"/></form>'
    result = xc.check(child, parent)
    kinds = {loc["kind"] for loc in result["locators"]}
    assert kinds == {"xpath", "direct"}
    assert result["summary"]["ok"] == 2


def test_direct_locator_no_identifying_attribute_is_skipped():
    child = '<newline position="after"/>'
    parent = "<form/>"
    result = xc.check(child, parent)
    assert result["locators"] == []


# --- the primary-on-primary case (odoo-manager's pilot tests, inline) --------

PILOT_CHILD = (
    "<data>"
    '<group name="group_general" position="inside"><field name="x_label"/></group>'
    "</data>"
)


def test_group_general_dead_against_raw_parent_text():
    # The parent's own arch, before composition with *its* parent: no group_general.
    raw_parent = '<form><sheet><field name="name"/></sheet></form>'
    result = xc.check(PILOT_CHILD, raw_parent)
    direct_hits = [loc for loc in result["locators"] if loc["kind"] == "direct"]
    assert direct_hits, "expected the group_general patch to be found as a direct locator"
    assert direct_hits[0]["status"] == "dead"


def test_group_general_ok_against_a_composed_parent():
    composed_parent = '<form><group name="group_general"><field name="other"/></group></form>'
    result = xc.check(PILOT_CHILD, composed_parent)
    direct_hits = [loc for loc in result["locators"] if loc["kind"] == "direct"]
    assert direct_hits[0]["status"] == "ok"


# --- added here: where each locator is, and the shorter equivalents ---------

def test_locators_carry_the_line_their_start_tag_ends_on_and_their_element():
    child = (
        "<data>\n"
        "  <xpath\n"
        "     expr=\"//field[@name='a']\"\n"
        "     position=\"after\">\n"
        "    <field name=\"new\"/>\n"
        "  </xpath>\n"
        "  <field name=\"b\" position=\"before\"/>\n"
        "</data>"
    )
    parent = '<form><field name="a"/><field name="b"/></form>'
    result = xc.check(child, parent)
    assert [(loc["kind"], loc["line"], loc["element"]) for loc in result["locators"]] == [
        ("xpath", 4, 1),
        ("direct", 7, 3),
    ]


def test_elements_count_in_document_order_without_comments():
    child = '<data><!-- <xpath expr="//zzz"/> --><xpath expr="//a"/><?pi x?><xpath expr="//b"/></data>'
    parent = "<form><a/><b/></form>"
    result = xc.check(child, parent)
    assert [(loc["expr"], loc["element"], loc["line"]) for loc in result["locators"]] == [("//a", 1, 1), ("//b", 2, 1)]


def test_a_long_unique_path_offers_shorter_equivalents():
    child = '<xpath expr="/form/sheet/group/field" position="after"><field name="y"/></xpath>'
    parent = '<form><sheet><group><field name="x"/></group></sheet></form>'
    result = xc.check(child, parent)
    locator = result["locators"][0]
    assert locator["status"] == "ok"
    assert locator["shorter"][0] == "//field[@name='x']"
    assert all(len(s) < len(locator["expr"]) for s in locator["shorter"])


if __name__ == "__main__":
    results = {}
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            try:
                function()
                results[name] = None
            except Exception:  # noqa: BLE001 - reported per test
                results[name] = traceback.format_exc()
    print(json.dumps(results))
