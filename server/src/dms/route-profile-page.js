import { withPortraitPage } from './portrait-page.js';
export { NeedsLoginError, SelectorError, LoadLimitError, CircuitBreakerError, CaptureError } from './portrait-page.js';

export async function captureRoutePortrait({ browserType, statePath, baseUrl, station, pageSize = 100,
  maxListRequests = 3, headless = false, log = () => {} }) {
  return withPortraitPage({ browserType, statePath, baseUrl, station, pageSize, maxListRequests, headless, log }, ({ body, counts }) => {
    const { requestCount, listRequestCount } = counts();
    return { body, requestCount, listRequestCount };
  });
}
