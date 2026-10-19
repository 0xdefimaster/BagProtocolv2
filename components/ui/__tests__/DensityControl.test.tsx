// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DensityControl, DENSITY_BOOT_SCRIPT, DENSITY_STORAGE_KEY, autoDensity } from '../DensityControl';

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.density;
  localStorage.clear();
});

describe('DensityControl', () => {
  it('auto follows the screen width: 80% from 1400px (also on wide screens), else 100%', () => {
    expect([autoDensity(2560), autoDensity(1920), autoDensity(1440), autoDensity(1280)]).toEqual(['80', '80', '80', '100']);
  });

  it('steps Auto → 100% → 80% → 67% → Auto, sets data-density and remembers the choice', () => {
    render(<DensityControl />);
    const btn = () => screen.getByRole('button', { name: /Screen density/ });
    fireEvent.click(btn());
    expect(document.documentElement.dataset.density).toBe('100');
    fireEvent.click(btn());
    fireEvent.click(btn());
    expect(document.documentElement.dataset.density).toBe('67');
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('67');
    fireEvent.click(btn());
    expect(document.documentElement.dataset.density).toBeUndefined();
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('auto');
  });

  it('the boot script applies a saved choice before paint and ignores anything else', () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, '80');
    new Function(DENSITY_BOOT_SCRIPT)();
    expect(document.documentElement.dataset.density).toBe('80');
    delete document.documentElement.dataset.density;
    localStorage.setItem(DENSITY_STORAGE_KEY, '0.1;evil');
    new Function(DENSITY_BOOT_SCRIPT)();
    expect(document.documentElement.dataset.density).toBeUndefined();
  });
});
