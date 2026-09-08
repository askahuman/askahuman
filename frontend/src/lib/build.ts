/** Public identity of this bundle, including when an older shell is cached. */
export const BUILD = {
  version: import.meta.env?.PUBLIC_BUILD_VERSION || 'dev',
  commit: import.meta.env?.PUBLIC_BUILD_COMMIT || 'unknown',
};
