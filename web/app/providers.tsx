"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            // A trading terminal is watched in a background tab as often as a
            // focused one. Without this React Query pauses every refetchInterval
            // once the tab is hidden, silently freezing quotes until the user
            // clicks back in. Keep polling regardless of visibility.
            refetchIntervalInBackground: true,
            refetchOnReconnect: true,
            retry: 1,
            // Never serve stale terminal data — bump to 0 so every query
            // honours its refetchInterval and reads are fresh.
            staleTime: 0,
          },
        },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
