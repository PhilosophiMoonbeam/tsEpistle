import type { AnchorHTMLAttributes, HTMLAttributes, InputHTMLAttributes } from 'vue'

// Native fallthrough attrs keep their finite Vue DOM types, independently of
// declared component props/emits. In particular, a component's select/submit/
// toggle payload must not intersect the DOM event of the same name.
declare module 'vue' {
  interface AllowedAttrs
    extends HTMLAttributes,
      Pick<InputHTMLAttributes, 'autofocus' | 'autocomplete' | 'disabled' | 'form' | 'inputmode' | 'maxlength' | 'minlength' | 'min' | 'max' | 'step' | 'name' | 'pattern' | 'placeholder' | 'required' | 'type'>,
      Pick<AnchorHTMLAttributes, 'download' | 'href' | 'hreflang' | 'referrerpolicy' | 'rel' | 'target'> {}
}

// Standard HTML <search> has ordinary global attributes and native events.
declare module '@vue/runtime-dom' {
  interface AriaAttributes {
    'aria-description'?: string
  }
  interface IntrinsicElementAttributes {
    search: HTMLAttributes
  }
}
