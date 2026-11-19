const CURRENT_APP = 'https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/';
const RETIRED_APPS = [
  'https://armshokri-debug.github.io/PUREFUNCTION-NEW',
  'https://audiovido.github.io/Purefunction-2'
];

/** Migrate the retired production link; retain explicit staging deployments. */
export function resolveAppUrl(configured?: string) {
  const url = configured?.trim();
  if (!url || RETIRED_APPS.includes(url.replace(/\/+$/, ''))) return CURRENT_APP;
  return url;
}
