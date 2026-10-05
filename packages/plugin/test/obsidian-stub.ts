// Runtime stand-in for the types-only `obsidian` package in unit tests.
export class TFile {}
export class Notice { constructor(_m?: string) {} }
export const normalizePath = (p: string) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, '')
export const moment = () => ({ format: () => '2026-10-05', valueOf: () => 0 })
