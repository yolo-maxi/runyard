import { docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';

// baseUrl is '/' because the whole app IS the docs site: the /docs prefix
// comes from Next's basePath, which is applied to links automatically.
export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
});
