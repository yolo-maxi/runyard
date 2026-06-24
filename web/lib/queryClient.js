import { QueryClient } from "@tanstack/react-query";

// Single QueryClient for the whole app. It is also the sync engine behind the
// TanStack DB collections (see collections.js), so it lives in its own module
// to avoid an import cycle between main.jsx and collections.js.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The Hub API is cookie-authed and cheap; refetch on focus is handy but
      // we keep retries low so auth failures surface quickly to the AuthGate.
      retry: 1,
      refetchOnWindowFocus: true,
      staleTime: 5_000
    }
  }
});
