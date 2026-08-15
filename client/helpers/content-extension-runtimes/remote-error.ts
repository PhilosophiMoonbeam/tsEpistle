export const showRemoteError = (element: HTMLElement, message: string): void => {
  const consent = element.querySelector<HTMLElement>('.content-extension-remote__consent')
  if (!consent) return
  const status = element.ownerDocument.createElement('p')
  status.className = 'content-extension-remote__error'
  status.setAttribute('role', 'alert')
  status.textContent = message
  consent.replaceChildren(status)
}
