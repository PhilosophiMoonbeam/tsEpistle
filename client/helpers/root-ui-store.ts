import type { Notification, WikiStore } from '../store/index.ts'

export function loadingStart (store: WikiStore, stackName: string): void {
  store.startLoading(stackName)
}

export function loadingStop (store: WikiStore, stackName: string): void {
  store.stopLoading(stackName)
}

export function setLoading (store: WikiStore, stackName: string, isLoading: boolean): void {
  if (isLoading) store.startLoading(stackName)
  else store.stopLoading(stackName)
}

export function showNotification (store: WikiStore, opts: Partial<Notification>): void {
  store.showNotification(opts)
}

export function updateNotificationState (store: WikiStore, isActive: boolean): void {
  store.setNotificationActive(isActive)
}

export function pushGraphError (store: WikiStore, err: unknown): void {
  store.showError(err)
}

export function isLoading (store: WikiStore): boolean {
  return store.isLoading
}

export function getNotification (store: WikiStore): Notification {
  return store.notification
}

export function getErrorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
