/**
 * Which side of an upgrade a window runs (design §7). Pure.
 */
import type { UpgradeConfigModel } from '../models/upgrade';

export type UpgradeSide = 'from' | 'to';

/**
 * The side this window runs: the one its bound version is, else the one its
 * active version is. A window running neither has no side.
 */
export function thisSide(
    config: Pick<UpgradeConfigModel, 'sideForVersion'>,
    bound: string | undefined,
    active: string | undefined
): UpgradeSide | undefined {
    return config.sideForVersion(bound) ?? config.sideForVersion(active);
}

export function otherSide(side: UpgradeSide): UpgradeSide {
    return side === 'from' ? 'to' : 'from';
}
