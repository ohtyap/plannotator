import { afterEach, describe, expect, jest, mock, spyOn, test } from 'bun:test';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { CompletionOverlay } from './CompletionOverlay';

type GlimpseWindow = Window & { glimpse?: { close: () => void } };

describe.if(typeof document !== 'undefined')('CompletionOverlay', () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    host?.remove();
    host = undefined;
    delete (window as GlimpseWindow).glimpse;
    resetStorageBackend();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function render(submitted: 'feedback' | 'done' | null) {
    if (!host) {
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
    }
    await act(async () => {
      root!.render(
        <StrictMode>
          <CompletionOverlay submitted={submitted} title="Finished" subtitle="" agentLabel="the CLI" />
        </StrictMode>,
      );
    });
    return host;
  }

  async function advance(ms: number) {
    await act(async () => { jest.advanceTimersByTime(ms); });
  }

  test('starts at completion and requests native close once after three seconds, ignoring the old cookie', async () => {
    jest.useFakeTimers();
    const getItem = mock((key: string) => key === 'plannotator-auto-close' ? 'off' : null);
    const setItem = mock(() => {});
    const removeItem = mock(() => {});
    setStorageBackend({ getItem, setItem, removeItem });
    let closeRequests = 0;
    (window as GlimpseWindow).glimpse = { close: () => { closeRequests++; } };

    await render(null);
    await advance(4000);
    expect(closeRequests).toBe(0);

    const page = await render('feedback');
    expect(page.textContent).toContain('close in 3 seconds');
    expect(page.textContent).not.toContain('Settings');
    expect(page.querySelector('input')).toBeNull();

    await advance(1000);
    expect(page.textContent).toContain('close in 2 seconds');
    await advance(1999);
    expect(page.textContent).toContain('close in 1 second');
    expect(closeRequests).toBe(0);
    await advance(1);
    expect(closeRequests).toBe(1);
    expect(page.textContent).toContain('has been sent');
    await advance(4000);
    expect(closeRequests).toBe(1);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  test('tells the user to close the tab manually if the browser blocks it', async () => {
    jest.useFakeTimers();
    const close = spyOn(window, 'close').mockImplementation(() => {});

    const page = await render('done');
    await advance(3000);
    expect(close).toHaveBeenCalledTimes(1);
    await advance(300);
    expect(page.textContent).toContain('Please close it manually');
    expect(page.textContent).not.toContain('Settings');
    expect(page.textContent).not.toContain('has been sent');
  });

  test('does not close if the completion screen is dismissed during the countdown', async () => {
    jest.useFakeTimers();
    const close = spyOn(window, 'close').mockImplementation(() => {});

    await render('done');
    await advance(2000);
    await render(null);
    await advance(2000);
    expect(close).not.toHaveBeenCalled();
  });
});
