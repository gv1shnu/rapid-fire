/** The deployed base path ('/' in dev, '/rapid-fire/' in production builds). */
export const BASE = import.meta.env.BASE_URL;

/** An in-app path under the base, e.g. appPath('instructor') -> '/rapid-fire/instructor'. */
export const appPath = (path = '') => `${BASE}${path}`;

/** The same path as an absolute URL on the current origin, for OAuth redirects and share links. */
export const appUrl = (path = '') =>
  `${window.location.origin}${appPath(path)}`;

/** The current route relative to the base, without a trailing slash: '', 'instructor', … */
export function route(pathname = window.location.pathname) {
  const local = pathname.startsWith(BASE)
    ? pathname.slice(BASE.length)
    : pathname.replace(/^\//, '');
  return local.replace(/\/+$/, '');
}
