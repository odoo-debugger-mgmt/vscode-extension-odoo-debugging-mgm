# Docs

User-facing documentation lives in the root [README](../README.md), the
[CHANGELOG](../CHANGELOG.md) and the Get Started walkthrough
(`media/walkthrough/`). This folder is for people working on the extension.

## Current

| Document | What it is for |
|---|---|
| [beta-1.3-testing.md](beta-1.3-testing.md) | What changed in 1.3.0 and what beta testers should try. |
| [manual-test-brief.md](manual-test-brief.md) | Manual test script for what the automated suite cannot judge: wording, sequence, appearance. |
| [media-capture-plan.md](media-capture-plan.md) | Which screen recordings to make for the README and walkthrough, and how. |

## Proposals

Designs not yet implemented. Read these as proposals: nothing in them exists
in the code until a later entry says so.

| Document | Topic |
|---|---|
| [2026-09-28-shared-data-store-design.md](superpowers/specs/2026-09-28-shared-data-store-design.md) | Sharing extension data across workspaces: a main store plus per-workspace state. |

## Historical design records

The specs, plans and notes below were written before the features they
describe were built, and are kept as a record of why things are the way they
are. They are **not maintained**: the code, the README and the CHANGELOG win
wherever they disagree.

| Date | Spec | Plan | Shipped in |
|---|---|---|---|
| 2026-07-06 | [Database & versions streamline](superpowers/specs/2026-07-06-db-versions-streamline-design.md) | | 1.2.0 |
| 2026-08-27 | [Native version provisioning](superpowers/specs/2026-08-27-native-version-provisioning-design.md) | [plan](superpowers/plans/2026-08-27-version-provisioning.md) | 1.3.0 |
| 2026-09-01 | [Per-version custom code](superpowers/specs/2026-09-01-custom-repo-worktrees-design.md) | [plan](superpowers/plans/2026-09-01-custom-repo-worktrees.md) | 1.3.0 |
| 2026-09-01 | Parallel version execution | [plan](superpowers/plans/2026-09-01-parallel-versions.md) | 1.3.0 |
| 2026-09-01 | [First-run setup](superpowers/specs/2026-09-01-first-run-setup-design.md) | | 1.3.0 |
| 2026-09-01 | [Onboarding rework notes](superpowers/notes/2026-09-01-onboarding-rework.md) | | 1.3.0 |
| 2026-09-02 | [Guided onboarding](superpowers/specs/2026-09-02-guided-onboarding-design.md) | [plan](superpowers/plans/2026-09-02-guided-onboarding.md) | 1.3.0 |

Upgrade mode as it now works (two databases, a remembered pair, the module-set
toggle) evolved past the per-version custom code spec; the README's
[Upgrade mode](../README.md#upgrade-mode) section describes the current
behaviour.
