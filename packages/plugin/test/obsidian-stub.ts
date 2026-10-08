// Runtime stand-in for the types-only `obsidian` package in unit tests.
export class TFile {}
export class Notice { constructor(_m?: string) {} }
export const normalizePath = (p: string) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, '')
export const moment = () => ({ format: () => '2026-10-05', valueOf: () => 0 })
export const Platform = { isMobile: false, isPhone: false, isTablet: false, isDesktopApp: true, isMobileApp: false, isIosApp: false, isAndroidApp: false }
