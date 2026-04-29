import filesize from 'filesize.js'
import _ from 'lodash'
import moment from 'moment-timezone'

/* global siteConfig */

const helpers = {
  /**
   * Convert bytes to humanized form
   * @param {number} rawSize Size in bytes
   * @returns {string} Humanized file size
   */
  filesize (rawSize) {
    return _.toUpper(filesize(rawSize))
  },
  /**
   * Convert raw path to safe path
   * @param {string} rawPath Raw path
   * @returns {string} Safe path
   */
  makeSafePath (rawPath) {
    let rawParts = _.split(_.trim(rawPath), '/')
    rawParts = _.map(rawParts, (r) => {
      return _.kebabCase(_.deburr(_.trim(r)))
    })

    return _.join(_.filter(rawParts, (r) => { return !_.isEmpty(r) }), '/')
  },
  resolvePath (path) {
    if (_.startsWith(path, '/')) { path = path.substring(1) }
    return `${siteConfig.path}${path}`
  },
  /**
   * Set Input Selection
   * @param {DOMElement} input The input element
   * @param {number} startPos The starting position
   * @param {nunber} endPos The ending position
   */
  setInputSelection (input, startPos, endPos) {
    input.focus()
    if (typeof input.selectionStart !== 'undefined') {
      input.selectionStart = startPos
      input.selectionEnd = endPos
    } else if (document.selection && document.selection.createRange) {
      // IE branch
      input.select()
      var range = document.selection.createRange()
      range.collapse(true)
      range.moveEnd('character', endPos)
      range.moveStart('character', startPos)
      range.select()
    }
  },
  /**
   * Format a value using the app moment-timezone instance.
   * @param {*} input Date/time input
   * @param {string} method Moment format token or supported method
   * @returns {*} Formatted value or original invalid input
   */
  formatMoment (input, method) {
    let date

    if (_.isArray(input) && _.isString(input[0])) {
      date = moment(input[0], input[1], true)
    } else if (_.isNumber(input)) {
      date = input.toString().length < 12 ? moment.unix(input) : moment(input)
    } else {
      date = moment(input)
    }

    if (!input || !date.isValid()) {
      console.warn('Could not build a valid `moment` object from input.')
      return input
    }

    switch (method) {
      case 'from':
        return date.fromNow(false)
      case 'calendar':
        return date.calendar(moment(), {})
      default:
        return date.format(method)
    }
  }
}

export default {
  install(Vue) {
    Vue.$helpers = helpers
    Vue.$moment = moment
    Vue.moment = moment
    Object.defineProperties(Vue.prototype, {
      $helpers: {
        get() {
          return helpers
        }
      },
      $moment: {
        get() {
          return moment
        }
      }
    })
  }
}
