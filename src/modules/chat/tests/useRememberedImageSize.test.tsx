import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { reservedImageBox, useRememberedImageSize } from '@/modules/chat/hooks/useRememberedImageSize';

function Probe({ imageKey }: { imageKey: string | null }) {
  const { size, remember } = useRememberedImageSize(imageKey);
  return <img alt="probe" data-size={size ? `${size.width}x${size.height}` : ''} onLoad={remember} />;
}

function loadWith(node: HTMLElement, width: number, height: number) {
  Object.defineProperty(node, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(node, 'naturalHeight', { value: height, configurable: true });
  fireEvent.load(node);
}

it('reports the decoded size after load and still knows it after a remount', () => {
  const first = render(<Probe imageKey="remount.png" />);
  expect(screen.getByRole('img').dataset.size).toBe('');
  loadWith(screen.getByRole('img'), 852, 1846);
  expect(screen.getByRole('img').dataset.size).toBe('852x1846');
  first.unmount();
  render(<Probe imageKey="remount.png" />);
  expect(screen.getByRole('img').dataset.size).toBe('852x1846');
});

it('keeps sizes separate per image key', () => {
  render(<Probe imageKey="a.png" />);
  loadWith(screen.getByRole('img'), 100, 50);
  render(<Probe imageKey="b.png" />);
  expect(screen.getAllByRole('img')[1].dataset.size).toBe('');
});

it('ignores images that decoded without a size', () => {
  render(<Probe imageKey="vector.svg" />);
  loadWith(screen.getByRole('img'), 0, 0);
  expect(screen.getByRole('img').dataset.size).toBe('');
});

it('remembers nothing without a key', () => {
  render(<Probe imageKey={null} />);
  loadWith(screen.getByRole('img'), 100, 50);
  expect(screen.getByRole('img').dataset.size).toBe('');
});

it('caps memory by dropping the oldest size', () => {
  const first = render(<Probe imageKey="oldest.png" />);
  loadWith(screen.getByRole('img'), 10, 10);
  first.unmount();
  for (let index = 0; index < 512; index += 1) {
    const filler = render(<Probe imageKey={`filler-${index}.png`} />);
    loadWith(screen.getByRole('img'), 10, 10);
    filler.unmount();
  }
  render(<Probe imageKey="oldest.png" />);
  expect(screen.getByRole('img').dataset.size).toBe('');
});

it('derives a box that never upscales, overflows or passes the height cap', () => {
  expect(reservedImageBox({ width: 852, height: 1846 }, '32rem')).toEqual({
    width: `min(852px, 100%, calc(32rem * ${852 / 1846}))`,
    aspectRatio: '852 / 1846',
  });
  expect(reservedImageBox({ width: 400, height: 300 })).toEqual({ width: 'min(400px, 100%)', aspectRatio: '400 / 300' });
});
