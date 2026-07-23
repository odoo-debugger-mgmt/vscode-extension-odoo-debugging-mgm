/**
 * Small TTL caches for expensive lookups (module/repo discovery, installed
 * modules, git branches) with targeted invalidation.
 */
interface TimedEntry<T> {
    value: T;
    expiresAt: number;
}

const DEFAULT_TTLS = {
    moduleDiscoveryMs: 5000,
    repositoryDiscoveryMs: 5000,
    installedModulesMs: 5000,
    installedModuleNamesMs: 5000,
    gitBranchMs: 3000
} as const;

class RuntimeCacheService {
    private readonly moduleDiscovery = new Map<string, TimedEntry<unknown>>();
    private readonly repositoryDiscovery = new Map<string, TimedEntry<unknown>>();
    private readonly installedModules = new Map<string, TimedEntry<unknown>>();
    private readonly installedModuleNames = new Map<string, TimedEntry<string[]>>();
    private readonly gitBranches = new Map<string, TimedEntry<string | null>>();

    private getOrCompute<T>(store: Map<string, TimedEntry<T>>, key: string, ttlMs: number, loader: () => T): T {
        const now = Date.now();
        const cached = store.get(key);
        if (cached && cached.expiresAt > now) {
            return cached.value;
        }

        const value = loader();
        store.set(key, { value, expiresAt: now + ttlMs });
        return value;
    }

    private async getOrComputeAsync<T>(store: Map<string, TimedEntry<T>>, key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
        const now = Date.now();
        const cached = store.get(key);
        if (cached && cached.expiresAt > now) {
            return cached.value;
        }

        const value = await loader();
        store.set(key, { value, expiresAt: now + ttlMs });
        return value;
    }

    getModuleDiscovery<T>(key: string, loader: () => T, ttlMs = DEFAULT_TTLS.moduleDiscoveryMs): T {
        return this.getOrCompute(this.moduleDiscovery as Map<string, TimedEntry<T>>, key, ttlMs, loader);
    }

    getRepositoryDiscovery<T>(key: string, loader: () => T, ttlMs = DEFAULT_TTLS.repositoryDiscoveryMs): T {
        return this.getOrCompute(this.repositoryDiscovery as Map<string, TimedEntry<T>>, key, ttlMs, loader);
    }

    async getInstalledModules<T>(dbName: string, loader: () => Promise<T>, ttlMs = DEFAULT_TTLS.installedModulesMs): Promise<T> {
        return this.getOrComputeAsync(this.installedModules as Map<string, TimedEntry<T>>, dbName, ttlMs, loader);
    }

    async getInstalledModuleNames(dbName: string, loader: () => Promise<string[]>, ttlMs = DEFAULT_TTLS.installedModuleNamesMs): Promise<string[]> {
        return this.getOrComputeAsync(this.installedModuleNames, dbName, ttlMs, loader);
    }

    async getGitBranch(repoPath: string, loader: () => Promise<string | null>, ttlMs = DEFAULT_TTLS.gitBranchMs): Promise<string | null> {
        return this.getOrComputeAsync(this.gitBranches, repoPath, ttlMs, loader);
    }

    invalidateModuleDiscoveryCache(key?: string): void {
        if (key) {
            this.moduleDiscovery.delete(key);
            return;
        }
        this.moduleDiscovery.clear();
    }

    invalidateRepositoryDiscoveryCache(key?: string): void {
        if (key) {
            this.repositoryDiscovery.delete(key);
            return;
        }
        this.repositoryDiscovery.clear();
    }

    invalidateInstalledModulesCache(dbName?: string): void {
        if (dbName) {
            this.installedModules.delete(dbName);
            this.installedModuleNames.delete(dbName);
            return;
        }
        this.installedModules.clear();
        this.installedModuleNames.clear();
    }

    invalidateGitBranchCache(repoPath?: string): void {
        if (repoPath) {
            this.gitBranches.delete(repoPath);
            return;
        }
        this.gitBranches.clear();
    }

    invalidateAll(): void {
        this.invalidateModuleDiscoveryCache();
        this.invalidateRepositoryDiscoveryCache();
        this.invalidateInstalledModulesCache();
        this.invalidateGitBranchCache();
    }
}

export const runtimeCache = new RuntimeCacheService();

export function invalidateModuleDiscoveryCache(key?: string): void {
    runtimeCache.invalidateModuleDiscoveryCache(key);
}

export function invalidateRepositoryDiscoveryCache(key?: string): void {
    runtimeCache.invalidateRepositoryDiscoveryCache(key);
}

export function invalidateInstalledModulesCache(dbName?: string): void {
    runtimeCache.invalidateInstalledModulesCache(dbName);
}

export function invalidateGitBranchCache(repoPath?: string): void {
    runtimeCache.invalidateGitBranchCache(repoPath);
}

export function invalidateAllRuntimeCaches(): void {
    runtimeCache.invalidateAll();
}
