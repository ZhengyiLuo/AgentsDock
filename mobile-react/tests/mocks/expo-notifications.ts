export function setNotificationHandler(): void {}
let permissionRequests = 0
export async function requestPermissionsAsync(): Promise<{ status: string }> { permissionRequests += 1; return { status: 'granted' } }
export function __notificationPermissionRequests(): number { return permissionRequests }
export function __resetNotifications(): void { permissionRequests = 0 }
export async function setBadgeCountAsync(): Promise<boolean> { return true }
export async function scheduleNotificationAsync(): Promise<string> { return 'mock-notification' }
export function addNotificationResponseReceivedListener(): { remove(): void } { return { remove() {} } }
export async function getLastNotificationResponseAsync(): Promise<null> { return null }
