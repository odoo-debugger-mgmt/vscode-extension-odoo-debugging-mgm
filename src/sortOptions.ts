export interface SortOption {
    id: string;
    label: string;
    description?: string;
}

export type SortableViewId =
    | 'projectSelector'
    | 'repoSelector'
    | 'dbSelector'
    | 'moduleSelector'
    | 'versionsManager'
    | 'projectRepos';

type SortOptionsMap = Record<SortableViewId, SortOption[]>;

export const SORT_OPTIONS: SortOptionsMap = {
    projectSelector: [
        { id: 'project:name:asc', label: 'Name (A → Z)' },
        { id: 'project:name:desc', label: 'Name (Z → A)' },
        { id: 'project:created:newest', label: 'Creation Date (Newest first)' },
        { id: 'project:created:oldest', label: 'Creation Date (Oldest first)' }
    ],
    repoSelector: [
        { id: 'repo:name:asc', label: 'Name (A → Z)' },
        { id: 'repo:name:desc', label: 'Name (Z → A)' },
        { id: 'repo:created:newest', label: 'Creation Date (Newest first)', description: 'Uses filesystem creation time' },
        { id: 'repo:created:oldest', label: 'Creation Date (Oldest first)', description: 'Uses filesystem creation time' }
    ],
    dbSelector: [
        { id: 'db:name:asc', label: 'Name (A → Z)' },
        { id: 'db:name:desc', label: 'Name (Z → A)' },
        { id: 'db:created:newest', label: 'Creation Date (Newest first)' },
        { id: 'db:created:oldest', label: 'Creation Date (Oldest first)' },
        { id: 'db:branch:asc', label: 'Branch (A → Z)' },
        { id: 'db:branch:desc', label: 'Branch (Z → A)' }
    ],
    moduleSelector: [
        { id: 'module:state:active-first', label: 'State (Install/Upgrade first)' },
        { id: 'module:state:active-last', label: 'State (Install/Upgrade last)' },
        { id: 'module:name:asc', label: 'Name (A → Z)' },
        { id: 'module:name:desc', label: 'Name (Z → A)' },
        { id: 'module:repo:asc', label: 'Repository (A → Z)' },
        { id: 'module:repo:desc', label: 'Repository (Z → A)' }
    ],
    versionsManager: [
        { id: 'version:name:asc', label: 'Name (A → Z)' },
        { id: 'version:name:desc', label: 'Name (Z → A)' },
        { id: 'version:created:newest', label: 'Creation Date (Newest first)' },
        { id: 'version:created:oldest', label: 'Creation Date (Oldest first)' },
        { id: 'version:odoo:asc', label: 'Odoo Version (A → Z)' },
        { id: 'version:odoo:desc', label: 'Odoo Version (Z → A)' }
    ],
    projectRepos: [
        { id: 'projectRepos:name:asc', label: 'Name (A → Z)' },
        { id: 'projectRepos:name:desc', label: 'Name (Z → A)' },
        { id: 'projectRepos:added:newest', label: 'Date Added (Newest first)' },
        { id: 'projectRepos:added:oldest', label: 'Date Added (Oldest first)' }
    ]
};

export function getDefaultSortOption(viewId: SortableViewId): string {
    return SORT_OPTIONS[viewId][0].id;
}

export function getSortOptions(viewId: SortableViewId): SortOption[] {
    return SORT_OPTIONS[viewId];
}
