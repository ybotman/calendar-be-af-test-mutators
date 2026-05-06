// Azure Functions entry — registers all TEST-mutator endpoints.
// Per ADR-0017: this Function App is deployed ONLY to the TEST tier.
// PROD deploy of this code is structurally impossible (separate repo + separate Function App).

'use strict';

require('./functions/preset-baseline');
require('./functions/reset-orphans');
require('./functions/reset-test-user');
require('./functions/elevate-test-user-role');
require('./functions/seed-with-correlation');
