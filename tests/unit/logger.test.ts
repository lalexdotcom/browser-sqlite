import { describe, it, expect } from '@rstest/core';
import { shouldLog, makeConsoleShim } from '../../src/logger';

describe('shouldLog', () => {
	it('returns false for debug when currentLevel is warn', () => {
		expect(shouldLog('debug', 'warn')).toBe(false);
	});

	it('returns true for error when currentLevel is warn', () => {
		expect(shouldLog('error', 'warn')).toBe(true);
	});

	it('returns true for warn when currentLevel is warn (exact match)', () => {
		expect(shouldLog('warn', 'warn')).toBe(true);
	});

	it('returns false for info when currentLevel is warn', () => {
		expect(shouldLog('info', 'warn')).toBe(false);
	});

	it('returns false for verb when currentLevel is warn', () => {
		expect(shouldLog('verb', 'warn')).toBe(false);
	});

	it('returns false for wth when currentLevel is warn', () => {
		expect(shouldLog('wth', 'warn')).toBe(false);
	});

	it('returns true for error when currentLevel is debug (permissive threshold)', () => {
		expect(shouldLog('error', 'debug')).toBe(true);
	});

	it('returns false for debug when currentLevel is error (strict threshold)', () => {
		expect(shouldLog('debug', 'error')).toBe(false);
	});
});

describe('makeConsoleShim', () => {
	it('returns an object with all 7 log methods', () => {
		const shim = makeConsoleShim('test');
		expect(typeof shim.debug).toBe('function');
		expect(typeof shim.info).toBe('function');
		expect(typeof shim.warn).toBe('function');
		expect(typeof shim.error).toBe('function');
		expect(typeof shim.verb).toBe('function');
		expect(typeof shim.wth).toBe('function');
		expect(typeof shim.success).toBe('function');
	});

	it('scope() returns a new instance (not the same reference)', () => {
		const shim = makeConsoleShim('parent');
		const child = shim.scope('child');
		expect(child).not.toBe(shim);
	});

	it('scope() returns an object with debug method', () => {
		const shim = makeConsoleShim('parent');
		const child = shim.scope('child');
		expect(typeof child.debug).toBe('function');
	});
});
