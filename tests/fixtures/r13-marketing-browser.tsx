import { createElement } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { MarketingWithdrawalForm } from '../../src/components/marketing-withdrawal-form';

// Only the local synthetic harness serves this entry point; no application route imports it.
const root = document.getElementById('r13-browser-fixture');
if (!root?.dataset.endpoint || !root.dataset.requestId) throw new Error('R13_FIXTURE_REQUIRED');
hydrateRoot(root, createElement(MarketingWithdrawalForm, {
  endpoint: root.dataset.endpoint,
  requestId: root.dataset.requestId,
}));
