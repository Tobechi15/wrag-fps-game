// Prefixes a public/ asset path with this build's actual base path - '/' in
// dev, '/play/' in a production build (see vite.config.js's `base` setting,
// added so the whole client can be reverse-proxied under <site>/play/ and
// stay same-origin with the dashboard - a browser drops an installed
// standalone-mode PWA back into normal browser chrome the instant it
// navigates to a different origin, which is exactly what used to happen
// every time the dashboard's Deploy button sent a player to this
// previously-separate-origin client). Every hardcoded absolute path this
// client uses for a public/ asset (audio, weapon/character/nature/prop
// models, muzzle flash textures, arm textures) needs to go through this -
// Vite's `base` config only auto-prefixes paths IT generates itself (the
// built index.html's own script/link tags, imported-as-modules assets), never
// a plain string literal like '/audio/gunshot-1.mp3' typed directly in
// source, which is how every one of those was written before this existed.
//
// import.meta.env.BASE_URL is set by Vite from that same `base` config,
// always with a trailing slash - callers pass a path starting with '/'
// (matching how these were all written before), so that leading slash is
// stripped first to avoid a doubled slash.
export function assetUrl(path) {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
}
