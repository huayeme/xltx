// Values shared by the browser extension modules. No user-visible behaviour
// should depend on a number written elsewhere in the extension code.
export const browserConfig = Object.freeze({
  runtimeDirectory: 'runtime/browser',
  executableName: 'chrome-headless-shell',
  fontsDirectory: 'fonts',
  librariesDirectory: 'lib',
  fontsConfigName: 'fonts.conf',
  fontsCacheName: 'fontcache',
  profileDirectory: 'data/browser-profile',
  taskProfileDirectory: 'data/browser-profile-task',
  executableSearchDepth: 4,
  fontDpi: 96,
  defaultTimeoutMs: 30000,
  navigationTimeoutMs: 30000,
  downloadTimeoutMs: 60000,
  scrollPixels: 600,
});
