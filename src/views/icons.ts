/**
 * Shared ThemeIcon constants so every view marks state the same way:
 * a green check-circle for the currently active item, a green filled
 * circle for "included in the current selection", and an outline when
 * not selected (mirrors the Modules view convention).
 */
import * as vscode from 'vscode';

const GREEN = new vscode.ThemeColor('charts.green');
const RED = new vscode.ThemeColor('charts.red');

/** The single currently-active item of a view (project, database, version). */
export const activeIcon = new vscode.ThemeIcon('pass-filled', GREEN);

// A check (included) vs an empty circle (not) so the state reads by SHAPE:
// when a row is selected VS Code repaints the icon with the selection
// foreground and the green tint is lost, but check-vs-circle still differs.
/** Item included in the current selection (repos, toggles). */
export const selectedIcon = new vscode.ThemeIcon('check', GREEN);

/** Item not included in the current selection. */
export const unselectedIcon = new vscode.ThemeIcon('circle-outline');

/** Test target states. */
export const includeIcon = new vscode.ThemeIcon('check', GREEN);
export const excludeIcon = new vscode.ThemeIcon('close', RED);
export const disabledIcon = new vscode.ThemeIcon('circle-slash');
