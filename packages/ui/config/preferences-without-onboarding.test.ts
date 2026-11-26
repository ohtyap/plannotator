import { afterEach, expect, mock, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { ConfigStoreForTest } from './configStore';
import { setReviewAutoViewed } from './reviewView';

function installBackend(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const getItem = mock((key: string) => values.get(key) ?? null);
  const setItem = mock((key: string, value: string) => { values.set(key, value); });
  setStorageBackend({ getItem, setItem, removeItem: (key) => { values.delete(key); } });
  return { getItem, setItem };
}

afterEach(resetStorageBackend);

test('the document defaults to Clean on a fresh profile', () => {
  installBackend();
  expect(new ConfigStoreForTest().get('gridEnabled')).toBe(false);
});

test('a saved Grid preference survives without consulting old chooser markers', () => {
  const markers = {
    'plannotator-plan-look-choice-resolved': 'true',
    'plannotator-look-feel-announcement-seen': '2',
    'plannotator-plan-look-v2': 'notice',
  };
  const { getItem, setItem } = installBackend({ 'plannotator-grid-enabled': 'true', ...markers });

  expect(new ConfigStoreForTest().get('gridEnabled')).toBe(true);
  expect(getItem).toHaveBeenCalledWith('plannotator-grid-enabled');
  expect(setItem.mock.calls.some(([key]) => key === 'plannotator-grid-enabled')).toBe(false);
  for (const key of Object.keys(markers)) {
    expect(getItem).not.toHaveBeenCalledWith(key);
    expect(setItem.mock.calls.some(([written]) => written === key)).toBe(false);
  }
});

test('turning off auto-mark viewed persists only the preference', () => {
  const { getItem, setItem } = installBackend();
  const store = new ConfigStoreForTest();
  expect(store.get('reviewAutoViewed')).toBe(true);

  setItem.mockClear();
  setReviewAutoViewed(false, store);
  expect(setItem.mock.calls).toEqual([['plannotator-review-auto-viewed', 'false']]);
  expect(new ConfigStoreForTest().get('reviewAutoViewed')).toBe(false);
  expect(getItem).not.toHaveBeenCalledWith('plannotator-auto-viewed-notice-seen');
});
