export function signInReturnPath(value: string | null, origin: string) {
  if (!value) return undefined;
  const url = URL.parse(value, origin);
  if (!url || url.origin !== origin || url.username || url.password || url.pathname.startsWith("//") ||
      /^\/sign-(?:in|up)(?:\/|$)/.test(url.pathname)) return undefined;
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("__clerk_") || key === "_rsc") url.searchParams.delete(key);
  }
  return url.pathname + url.search + url.hash;
}
