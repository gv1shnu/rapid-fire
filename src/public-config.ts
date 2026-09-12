/** Fail before creating a browser client or emitting a bundle with a privileged key. */
export function assertPublicKey(key: string | undefined) {
  if (!key) return;
  if (key.startsWith('sb_secret_'))
    throw new Error('A secret Supabase key cannot be used in the browser.');
  if (key.split('.').length === 3) {
    let role: unknown;
    try {
      role = JSON.parse(
        atob(key.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')),
      ).role;
    } catch {
      throw new Error('Invalid Supabase public key.');
    }
    if (role !== 'anon')
      throw new Error(
        'Only a publishable or anon Supabase key may be used in the browser.',
      );
  }
}
