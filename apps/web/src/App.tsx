import { useQuery } from '@tanstack/react-query';
import { pageTitle } from './title';

export function App() {
  const health = useQuery({
    queryKey: ['healthz'],
    queryFn: async () => {
      const res = await fetch('/api/healthz');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { status: string };
    },
    retry: false,
  });

  return (
    <main>
      <h1>{pageTitle()}</h1>
      <p>Placeholder da fase 0. API: {health.isSuccess ? health.data.status : 'indisponível'}</p>
    </main>
  );
}
