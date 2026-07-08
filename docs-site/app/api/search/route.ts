import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

export const revalidate = false;

// With `output: 'export'`, staticGET makes `next build` write the whole
// Orama search index to out/api/search as a static JSON payload; the search
// dialog fetches and queries it entirely client-side.
export const { staticGET: GET } = createFromSource(source, {
  language: 'english',
});
