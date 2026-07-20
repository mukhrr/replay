import { useCallback, useEffect, useState } from 'react';

/**
 * A ~20-line History-API router. Real enough to exercise a route change in the
 * recorder without pulling a routing library into the demo's dependency tree.
 */
export function useRoute(): [string, (to: string) => void] {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState({}, '', to);
    setPathname(to);
  }, []);

  return [pathname, navigate];
}
