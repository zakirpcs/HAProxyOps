import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FleetProvider } from "../useFleet";

/**
 * Renders inside the same provider stack as `main.tsx`.
 *
 * Page components reach for whichever of these they need - NodeDetail pulls in
 * react-query through its metrics panel - so mounting one without the stack
 * fails on a missing provider rather than on the behaviour under test.
 */
export function renderWithProviders(ui: ReactNode, { route = "/" } = {}) {
  const client = new QueryClient({
    // No retries and no caching between tests: a retry turns a deliberate
    // failure case into a timeout, and a shared cache leaks state across tests.
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <FleetProvider>{ui}</FleetProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
