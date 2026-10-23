/** Existing JavaScript packaging module: only the function consumed by typed source Peekaboo sync is declared. */
export declare function installPinnedPeekabooRuntime(releaseDir: string): Promise<void>;

/** Existing JS packaging module: source tunnel sync calls exactly target and release directory. */
export declare function installPinnedTunnelRuntime(target: string, releaseDir: string): Promise<void>;

/** Existing macOS JS packager: only the Main artifact builder's consumed interface. */
export declare function packageManagedEquinoxRelease(options: { rootDir: string; target: string }): Promise<{ target: string; artifactPath: string }>;
