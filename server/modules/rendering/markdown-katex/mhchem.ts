/* -*- Mode: Javascript; indent-tabs-mode:nil; js-indent-level: 2 -*- */
/* vim: set ts=2 et sw=2 tw=80: */

/*************************************************************
 *
 *  KaTeX mhchem.js
 *
 *  This file implements a KaTeX version of mhchem version 3.3.0.
 *  It is adapted from MathJax/extensions/TeX/mhchem.js
 *  It differs from the MathJax version as follows:
 *    1. The interface is changed so that it can be called from KaTeX, not MathJax.
 *    2. \rlap and \llap are replaced with \mathrlap and \mathllap.
 *    3. Four lines of code are edited in order to use \raisebox instead of \raise.
 *    4. The reaction arrow code is simplified. All reaction arrows are rendered
 *       using KaTeX extensible arrows instead of building non-extensible arrows.
 *    5. \tripledash vertical alignment is slightly adjusted.
 *
 *    This code, as other KaTeX code, is released under the MIT license.
 *
 * /*************************************************************
 *
 *  MathJax/extensions/TeX/mhchem.js
 *
 *  Implements the \ce command for handling chemical formulas
 *  from the mhchem LaTeX package.
 *
 *  ---------------------------------------------------------------------
 *
 *  Copyright (c) 2011-2015 The MathJax Consortium
 *  Copyright (c) 2015-2018 Martin Hensel
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

//
// Coding Style
//   - use '' for identifiers that can by minified/uglified
//   - use "" for strings that need to stay untouched

// version: "3.3.0" for MathJax and KaTeX

interface MacroToken {
  text: string
  loc: {
    start: number
  }
}

type StateMachineName =
  | 'ce'
  | 'a'
  | 'o'
  | 'text'
  | 'pq'
  | 'bd'
  | 'oxidation'
  | 'tex-math'
  | 'tex-math tight'
  | '9,9'
  | 'pu'
  | 'pu-2'
  | 'pu-9,9'

type ArrowKind =
  | '->'
  | '\u2192'
  | '\u27F6'
  | '<-'
  | '<->'
  | '<-->'
  | '<=>'
  | '\u21CC'
  | '<=>>'
  | '<<=>'

type BondKind =
  | '-'
  | '1'
  | '='
  | '2'
  | '#'
  | '3'
  | '~'
  | '~-'
  | '~='
  | '~--'
  | '-~-'
  | '...'
  | '....'
  | '->'
  | '<-'
  | '<'
  | '>'

type OperatorKind =
  | '+'
  | '-'
  | '='
  | '<'
  | '>'
  | '<<'
  | '>>'
  | '\\pm'
  | '\\approx'
  | '$\\approx$'
  | 'v'
  | '(v)'
  | '^'
  | '(^)'

type TypeOnlyOutputKind =
  | 'space'
  | 'entitySkip'
  | 'pu-space-1'
  | 'pu-space-2'
  | '1000 separator'
  | 'commaDecimal'
  | 'hyphen'
  | 'addition compound'
  | 'electron dot'
  | 'KV x'
  | 'prime'
  | 'cdot'
  | 'tight cdot'
  | 'times'
  | 'circa'
  | '^'
  | 'v'
  | 'ellipsis'
  | '/'
  | ' / '

interface ChemfiveOutput {
  type_: 'chemfive'
  a: ParserOutput[]
  b: ParserOutput[]
  p: ParserOutput[]
  o: ParserOutput[]
  q: ParserOutput[]
  d: ParserOutput[]
  dType: 'kv' | 'oxidation' | undefined
}

type OutputWithP1<Kind extends string, Value> = Kind extends Kind
  ? { type_: Kind, p1: Value }
  : never

type OutputWithP1P2<Kind extends string, Value> = Kind extends Kind
  ? { type_: Kind, p1: Value, p2: Value }
  : never

type OutputWithoutFields<Kind extends string> = Kind extends Kind
  ? { type_: Kind }
  : never

type ScalarOutput = OutputWithP1<
  | 'rm'
  | 'text'
  | 'roman numeral'
  | '1st-level escape'
  | 'comma enumeration L'
  | 'comma enumeration M'
  | 'comma enumeration S',
  string
>

type NestedOutput = OutputWithP1<
  'state of aggregation' | 'state of aggregation subscript',
  ParserOutput[]
>

type NestedPairOutput = OutputWithP1P2<
  'pu-frac' | 'frac-ce' | 'overset' | 'underset' | 'underbrace',
  ParserOutput[]
>

interface FractionOutput {
  type_: 'frac'
  p1: string
  p2: string
}

interface MathOutput {
  type_: 'tex-math'
  p1: string
}

interface ColorOutput {
  type_: 'color'
  color1: string
  color2: ParserOutput[]
}

interface ColorDeclarationOutput {
  type_: 'color0'
  color: string
}

interface ArrowOutput {
  type_: 'arrow'
  r: ArrowKind
  rd: ParserOutput[]
  rq: ParserOutput[]
}

interface BondOutput {
  type_: 'bond'
  kind_: BondKind
}

interface OperatorOutput {
  type_: 'operator'
  kind_: OperatorKind
}

type TypeOnlyOutput = OutputWithoutFields<TypeOnlyOutputKind>

type ParserOutputObject =
  | ChemfiveOutput
  | ScalarOutput
  | NestedOutput
  | NestedPairOutput
  | FractionOutput
  | MathOutput
  | ColorOutput
  | ColorDeclarationOutput
  | ArrowOutput
  | BondOutput
  | OperatorOutput
  | TypeOnlyOutput

type ParserOutput = string | ParserOutputObject

interface ParserBuffer {
  [key: string]: string | number | boolean | undefined
  parenthesisLevel: number
  a?: string | undefined
  b?: string | undefined
  p?: string | undefined
  o?: string | undefined
  q?: string | undefined
  d?: string | undefined
  dType?: 'kv' | 'oxidation' | undefined
  rm?: string | undefined
  text_?: string | undefined
  r?: ArrowKind | undefined
  rdt?: string | undefined
  rd?: string | undefined
  rqt?: string | undefined
  rq?: string | undefined
  sb?: boolean | undefined
  beginsWithBond?: boolean | undefined
}

type MatchValue = string | (string | undefined)[]

type ScientificNumberMatch = [
  sign: string | undefined,
  coefficient: string | undefined,
  uncertainty: string | undefined,
  exponentMarker: string | undefined,
  multiplicationMarker: string | undefined,
  exponent: string | undefined
]

type PowerNumberMatch = [
  sign: string | undefined,
  coefficient: string,
  exponent: string
]

type ActionOption = string | number | boolean

interface PatternMatch {
  match_: MatchValue
  remainder: string
}

type PatternMatcher = (input: string) => PatternMatch | null
type Pattern = RegExp | PatternMatcher
type PatternDelimiter = string | RegExp

interface ParserPatterns {
  patterns: Record<string, Pattern>
  findObserveGroups(
    input: string,
    begExcl: PatternDelimiter,
    begIncl: PatternDelimiter,
    endIncl: PatternDelimiter,
    endExcl: PatternDelimiter,
    beg2Excl?: PatternDelimiter,
    beg2Incl?: PatternDelimiter,
    end2Incl?: PatternDelimiter,
    end2Excl?: PatternDelimiter,
    combine?: boolean
  ): PatternMatch | null
  match_(patternName: string, input: string): PatternMatch | null
}

type ParserAction = {
  bivarianceHack(
    this: Record<string, ParserAction>,
    buffer: ParserBuffer,
    match: MatchValue,
    option?: ActionOption
  ): ParserOutput | ParserOutput[] | void
}['bivarianceHack']

interface ActionDescriptor {
  type_: string
  option?: ActionOption
}

type ActionDefinition = string | ActionDescriptor

interface TransitionDefinition {
  action_?: ActionDefinition | ActionDefinition[]
  nextState?: string
  revisit?: boolean
  toContinue?: boolean
  stateArray?: string[]
}

type TransitionDefinitions = Record<string, Record<string, TransitionDefinition>>

interface TransitionTask {
  action_: ActionDescriptor[]
  nextState?: string
  revisit?: boolean
  toContinue?: boolean
}

interface Transition {
  pattern: string
  task: TransitionTask
}

type Transitions = Record<string, Transition[]>

interface StateMachine {
  transitions: Transitions
  actions: Record<string, ParserAction>
}

interface MhchemParser {
  go(input: string | undefined, stateMachine?: StateMachineName): ParserOutput[]
  concatArray(
    target: ParserOutput[],
    value: ParserOutput | ParserOutput[] | void
  ): void
  patterns: ParserPatterns
  actions: Record<string, ParserAction>
  createTransitions(definitions: TransitionDefinitions): Transitions
  stateMachines: Partial<Record<StateMachineName, StateMachine>>
}

function requireMacroToken(tokens: MacroToken[], index: number): MacroToken {
  const token = tokens[index]
  if (!token) {
    throw new Error('mhchem received an incomplete macro token stream')
  }
  return token
}


function requireMatchText(value: MatchValue, action: string): string {
  if (typeof value !== 'string') {
    throw new Error(`mhchem action ${action} requires a text match`)
  }
  return value
}


function requireTypeOnlyOutputKind(value: ActionOption | undefined): TypeOnlyOutputKind {
  switch (value) {
    case 'space':
    case 'entitySkip':
    case 'pu-space-1':
    case 'pu-space-2':
    case '1000 separator':
    case 'commaDecimal':
    case 'hyphen':
    case 'addition compound':
    case 'electron dot':
    case 'KV x':
    case 'prime':
    case 'cdot':
    case 'tight cdot':
    case 'times':
    case 'circa':
    case '^':
    case 'v':
    case 'ellipsis':
    case '/':
    case ' / ':
      return value
    default:
      throw new Error('mhchem insert action received an invalid output kind')
  }
}

function requireScalarOutputKind(value: ActionOption | undefined): ScalarOutput['type_'] {
  switch (value) {
    case 'rm':
    case 'text':
    case 'roman numeral':
    case '1st-level escape':
    case 'comma enumeration L':
    case 'comma enumeration M':
    case 'comma enumeration S':
      return value
    default:
      throw new Error('mhchem insert action received an invalid scalar output kind')
  }
}

function requireBondKind(value: MatchValue | ActionOption | undefined): BondKind {
  switch (value) {
    case '-':
    case '1':
    case '=':
    case '2':
    case '#':
    case '3':
    case '~':
    case '~-':
    case '~=':
    case '~--':
    case '-~-':
    case '...':
    case '....':
    case '->':
    case '<-':
    case '<':
    case '>':
      return value
    default:
      throw new Error('mhchem bond action received an invalid bond kind')
  }
}

function invokeParserAction(
  actions: Record<string, ParserAction>,
  name: string,
  buffer: ParserBuffer,
  match: MatchValue = '',
  option?: ActionOption
): ParserOutput | ParserOutput[] | void {
  const action = actions[name]
  if (!action) {
    throw new Error('mhchem action is not initialized: ' + name)
  }
  return action.call(actions, buffer, match, option)
}

  //
  //  This is the main function for handing the \ce and \pu commands.
  //  It takes the argument to \ce or \pu and returns the corresponding TeX string.
  //

  const mhchem = function (tokens: MacroToken[], stateMachine: 'ce' | 'pu'): string {
    // Recreate the argument string from KaTeX's array of tokens.
    let str = "";
    const finalToken = requireMacroToken(tokens, tokens.length - 1)
    let expectedLoc = finalToken.loc.start
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = requireMacroToken(tokens, i)
      if(token.loc.start > expectedLoc) {
        // context.consumeArgs has eaten a space.
        str += " ";
        expectedLoc = token.loc.start;
      }
      str += token.text;
      expectedLoc += token.text.length;
    }
    const tex = texify.go(mhchemParser.go(str, stateMachine));
    return tex;
  };

  //
  // Core parser for mhchem syntax  (recursive)
  //
  const mhchemParser: MhchemParser = {
    //
    // Parses mchem \ce syntax
    //
    // Call like
    //   go("H2O");
    //
    go: function (input: string | undefined, stateMachine: StateMachineName = 'ce'): ParserOutput[] {
      if (!input) { return []; }
      let state = '0';

      //
      // String buffers for parsing:
      //
      // buffer.a == amount
      // buffer.o == element
      // buffer.b == left-side superscript
      // buffer.p == left-side subscript
      // buffer.q == right-side subscript
      // buffer.d == right-side superscript
      //
      // buffer.r == arrow
      // buffer.rdt == arrow, script above, type
      // buffer.rd == arrow, script above, content
      // buffer.rqt == arrow, script below, type
      // buffer.rq == arrow, script below, content
      //
      // buffer.text_
      // buffer.rm
      // etc.
      //
      // buffer.parenthesisLevel == int, starting at 0
      // buffer.sb == bool, space before
      // buffer.beginsWithBond == bool
      //
      // These letters are also used as state names.
      //
      // Other states:
      // 0 == begin of main part (arrow/operator unlikely)
      // 1 == next entity
      // 2 == next entity (arrow/operator unlikely)
      // 3 == next atom
      // c == macro
      //
      const buffer: ParserBuffer = {
        parenthesisLevel: 0
      };

      let remainingInput = input.replace(/\n/g, " ");
      remainingInput = remainingInput.replace(/[\u2212\u2013\u2014\u2010]/g, "-");
      remainingInput = remainingInput.replace(/[\u2026]/g, "...");

      //
      // Looks through mhchemParser.transitions, to execute a matching action
      // (recursive)
      //
      let lastInput: string | undefined;
      let watchdog = 10;
      const output: ParserOutput[] = [];
      while (true) {
        if (lastInput !== remainingInput) {
          watchdog = 10;
          lastInput = remainingInput;
        } else {
          watchdog--;
        }
        //
        // Find actions in transition table
        //
        const machine = mhchemParser.stateMachines[stateMachine];
        if (!machine) {
          throw new Error("mhchem state machine is not initialized: " + stateMachine)
        }
        const t = machine.transitions[state] || machine.transitions['*'];
        if (!t) {
          throw new Error("mhchem state has no transitions: " + state)
        }
        iterateTransitions:
        for (let i=0; i<t.length; i++) {
          const transition = t[i]
          if (!transition) {
            continue
          }
          const matches = mhchemParser.patterns.match_(transition.pattern, remainingInput);
          if (matches) {
            //
            // Execute actions
            //
            const task = transition.task;
            for (let iA=0; iA<task.action_.length; iA++) {
              const actionDescriptor = task.action_[iA]
              if (!actionDescriptor) {
                continue
              }
              //
              // Find and execute action
              //
              const machineAction = machine.actions[actionDescriptor.type_]
              const actionOutput = machineAction
                ? machineAction.call(
                    machine.actions,
                    buffer,
                    matches.match_,
                    actionDescriptor.option
                  )
                : invokeParserAction(
                    mhchemParser.actions,
                    actionDescriptor.type_,
                    buffer,
                    matches.match_,
                    actionDescriptor.option
                  )
              mhchemParser.concatArray(output, actionOutput);
            }
            //
            // Set next state,
            // Shorten input,
            // Continue with next character
            //   (= apply only one transition per position)
            //
            state = task.nextState || state;
            if (remainingInput.length > 0) {
              if (!task.revisit) {
                remainingInput = matches.remainder;
              }
              if (!task.toContinue) {
                break iterateTransitions;
              }
            } else {
              return output;
            }
          }
        }
        //
        // Prevent infinite loop
        //
        if (watchdog <= 0) {
          throw ["MhchemBugU", "mhchem bug U. Please report."];  // Unexpected character
        }
      }
    },
    concatArray: function (a: ParserOutput[], b: ParserOutput | ParserOutput[] | void): void {
      if (b) {
        if (Array.isArray(b)) {
          for (let iB=0; iB<b.length; iB++) {
            const item = b[iB]
            if (item !== undefined) {
              a.push(item);
            }
          }
        } else {
          a.push(b);
        }
      }
    },

    patterns: {
      //
      // Matching patterns
      // either regexps or function that return null or {match_:"a", remainder:"bc"}
      //
      patterns: {
        // property names must not look like integers ("2") for correct property traversal order, later on
        'empty': /^$/,
        'else': /^./,
        'else2': /^./,
        'space': /^\s/,
        'space A': /^\s(?=[A-Z\\$])/,
        'space$': /^\s$/,
        'a-z': /^[a-z]/,
        'x': /^x/,
        'x$': /^x$/,
        'i$': /^i$/,
        'letters': /^(?:[a-zA-Z\u03B1-\u03C9\u0391-\u03A9?@]|(?:\\(?:alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)(?:\s+|\{\}|(?![a-zA-Z]))))+/,
        '\\greek': /^\\(?:alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)(?:\s+|\{\}|(?![a-zA-Z]))/,
        'one lowercase latin letter $': /^(?:([a-z])(?:$|[^a-zA-Z]))$/,
        '$one lowercase latin letter$ $': /^\$(?:([a-z])(?:$|[^a-zA-Z]))\$$/,
        'one lowercase greek letter $': /^(?:\$?[\u03B1-\u03C9]\$?|\$?\\(?:alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)\s*\$?)(?:\s+|\{\}|(?![a-zA-Z]))$/,
        'digits': /^[0-9]+/,
        '-9.,9': /^[+-]?(?:[0-9]+(?:[,.][0-9]+)?|[0-9]*(?:\.[0-9]+))/,
        '-9.,9 no missing 0': /^[+-]?[0-9]+(?:[.,][0-9]+)?/,
        '(-)(9.,9)(e)(99)': function (input) {
          const m = input.match(/^(\+-|\+\/-|\+|-|\\pm\s?)?([0-9]+(?:[,.][0-9]+)?|[0-9]*(?:\.[0-9]+))?(\((?:[0-9]+(?:[,.][0-9]+)?|[0-9]*(?:\.[0-9]+))\))?(?:([eE]|\s*(\*|x|\\times|\u00D7)\s*10\^)([+-]?[0-9]+|\{[+-]?[0-9]+\}))?/);
          if (m && m[0]) {
            return { match_: m.splice(1), remainder: input.substr(m[0].length) };
          }
          return null;
        },
        '(-)(9)^(-9)': function (input) {
          const m = input.match(/^(\+-|\+\/-|\+|-|\\pm\s?)?([0-9]+(?:[,.][0-9]+)?|[0-9]*(?:\.[0-9]+)?)\^([+-]?[0-9]+|\{[+-]?[0-9]+\})/);
          if (m && m[0]) {
            return { match_: m.splice(1), remainder: input.substr(m[0].length) };
          }
          return null;
        },
        'state of aggregation $': function (input) {  // ... or crystal system
          const a = mhchemParser.patterns.findObserveGroups(input, "", /^\([a-z]{1,3}(?=[),])/, ")", "");  // (aq), (aq,$\infty$), (aq, sat)
          if (a  &&  a.remainder.match(/^($|[\s,;)\]}])/)) { return a; }  //  AND end of 'phrase'
          const m = input.match(/^(?:\((?:\\ca\s?)?\$[amothc]\$\))/);  // OR crystal system ($o$) (\ca$c$)
          if (m) {
            return { match_: m[0], remainder: input.substr(m[0].length) };
          }
          return null;
        },
        '_{(state of aggregation)}$': /^_\{(\([a-z]{1,3}\))\}/,
        '{[(': /^(?:\\\{|\[|\()/,
        ')]}': /^(?:\)|\]|\\\})/,
        ', ': /^[,;]\s*/,
        ',': /^[,;]/,
        '.': /^[.]/,
        '. ': /^([.\u22C5\u00B7\u2022])\s*/,
        '...': /^\.\.\.(?=$|[^.])/,
        '* ': /^([*])\s*/,
        '^{(...)}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "^{", "", "", "}"); },
        '^($...$)': function (input) { return mhchemParser.patterns.findObserveGroups(input, "^", "$", "$", ""); },
        '^a': /^\^([0-9]+|[^\\_])/,
        '^\\x{}{}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "^", /^\\[a-zA-Z]+\{/, "}", "", "", "{", "}", "", true); },
        '^\\x{}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "^", /^\\[a-zA-Z]+\{/, "}", ""); },
        '^\\x': /^\^(\\[a-zA-Z]+)\s*/,
        '^(-1)': /^\^(-?\d+)/,
        '\'': /^'/,
        '_{(...)}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "_{", "", "", "}"); },
        '_($...$)': function (input) { return mhchemParser.patterns.findObserveGroups(input, "_", "$", "$", ""); },
        '_9': /^_([+-]?[0-9]+|[^\\])/,
        '_\\x{}{}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "_", /^\\[a-zA-Z]+\{/, "}", "", "", "{", "}", "", true); },
        '_\\x{}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "_", /^\\[a-zA-Z]+\{/, "}", ""); },
        '_\\x': /^_(\\[a-zA-Z]+)\s*/,
        '^_': /^(?:\^(?=_)|_(?=\^)|[\^_]$)/,
        '{}': /^\{\}/,
        '{...}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "", "{", "}", ""); },
        '{(...)}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "{", "", "", "}"); },
        '$...$': function (input) { return mhchemParser.patterns.findObserveGroups(input, "", "$", "$", ""); },
        '${(...)}$': function (input) { return mhchemParser.patterns.findObserveGroups(input, "${", "", "", "}$"); },
        '$(...)$': function (input) { return mhchemParser.patterns.findObserveGroups(input, "$", "", "", "$"); },
        '=<>': /^[=<>]/,
        '#': /^[#\u2261]/,
        '+': /^\+/,
        '-$': /^-(?=[\s_},;\]/]|$|\([a-z]+\))/,  // -space -, -; -] -/ -$ -state-of-aggregation
        '-9': /^-(?=[0-9])/,
        '- orbital overlap': /^-(?=(?:[spd]|sp)(?:$|[\s,;)\]}]))/,
        '-': /^-/,
        'pm-operator': /^(?:\\pm|\$\\pm\$|\+-|\+\/-)/,
        'operator': /^(?:\+|(?:[-=<>]|<<|>>|\\approx|\$\\approx\$)(?=\s|$|-?[0-9]))/,
        'arrowUpDown': /^(?:v|\(v\)|\^|\(\^\))(?=$|[\s,;)\]}])/,
        '\\bond{(...)}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "\\bond{", "", "", "}"); },
        '->': /^(?:<->|<-->|->|<-|<=>>|<<=>|<=>|[\u2192\u27F6\u21CC])/,
        'CMT': /^[CMT](?=\[)/,
        '[(...)]': function (input) { return mhchemParser.patterns.findObserveGroups(input, "[", "", "", "]"); },
        '1st-level escape': /^(&|\\\\|\\hline)\s*/,
        '\\,': /^(?:\\[, ;:])/,  // \\x - but output no space before
        '\\x{}{}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "", /^\\[a-zA-Z]+\{/, "}", "", "", "{", "}", "", true); },
        '\\x{}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "", /^\\[a-zA-Z]+\{/, "}", ""); },
        '\\ca': /^\\ca(?:\s+|(?![a-zA-Z]))/,
        '\\x': /^(?:\\[a-zA-Z]+\s*|\\[_&{}%])/,
        'orbital': /^(?:[0-9]{1,2}[spdfgh]|[0-9]{0,2}sp)(?=$|[^a-zA-Z])/,  // only those with numbers in front, because the others will be formatted correctly anyway
        'others': /^[/~|]/,
        '\\frac{(...)}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "\\frac{", "", "", "}", "{", "", "", "}"); },
        '\\overset{(...)}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "\\overset{", "", "", "}", "{", "", "", "}"); },
        '\\underset{(...)}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "\\underset{", "", "", "}", "{", "", "", "}"); },
        '\\underbrace{(...)}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "\\underbrace{", "", "", "}_", "{", "", "", "}"); },
        '\\color{(...)}0': function (input) { return mhchemParser.patterns.findObserveGroups(input, "\\color{", "", "", "}"); },
        '\\color{(...)}{(...)}1': function (input) { return mhchemParser.patterns.findObserveGroups(input, "\\color{", "", "", "}", "{", "", "", "}"); },
        '\\color(...){(...)}2': function (input) { return mhchemParser.patterns.findObserveGroups(input, "\\color", "\\", "", /^(?=\{)/, "{", "", "", "}"); },
        '\\ce{(...)}': function (input) { return mhchemParser.patterns.findObserveGroups(input, "\\ce{", "", "", "}"); },
        'oxidation$': /^(?:[+-][IVX]+|\\pm\s*0|\$\\pm\$\s*0)$/,
        'd-oxidation$': /^(?:[+-]?\s?[IVX]+|\\pm\s*0|\$\\pm\$\s*0)$/,  // 0 could be oxidation or charge
        'roman numeral': /^[IVX]+/,
        '1/2$': /^[+-]?(?:[0-9]+|\$[a-z]\$|[a-z])\/[0-9]+(?:\$[a-z]\$|[a-z])?$/,
        'amount': function (input) {
          let match;
          // e.g. 2, 0.5, 1/2, -2, n/2, +;  $a$ could be added later in parsing
          match = input.match(/^(?:(?:(?:\([+-]?[0-9]+\/[0-9]+\)|[+-]?(?:[0-9]+|\$[a-z]\$|[a-z])\/[0-9]+|[+-]?[0-9]+[.,][0-9]+|[+-]?\.[0-9]+|[+-]?[0-9]+)(?:[a-z](?=\s*[A-Z]))?)|[+-]?[a-z](?=\s*[A-Z])|\+(?!\s))/);
          if (match) {
            return { match_: match[0], remainder: input.substr(match[0].length) };
          }
          const a = mhchemParser.patterns.findObserveGroups(input, "", "$", "$", "");
          if (a && typeof a.match_ === 'string') {  // e.g. $2n-1$, $-$
            match = a.match_.match(/^\$(?:\(?[+-]?(?:[0-9]*[a-z]?[+-])?[0-9]*[a-z](?:[+-][0-9]*[a-z]?)?\)?|\+|-)\$$/);
            if (match) {
              return { match_: match[0], remainder: input.substr(match[0].length) };
            }
          }
          return null;
        },
        'amount2': function (input) {
          const amountPattern = mhchemParser.patterns.patterns['amount']
          return typeof amountPattern === 'function' ? amountPattern(input) : null
        },
        '(KV letters),': /^(?:[A-Z][a-z]{0,2}|i)(?=,)/,
        'formula$': function (input) {
          if (input.match(/^\([a-z]+\)$/)) { return null; }  // state of aggregation = no formula
          const match = input.match(/^(?:[a-z]|(?:[0-9 +\-,.()]+[a-z])+[0-9 +\-,.()]*|(?:[a-z][0-9 +\-,.()]+)+[a-z]?)$/);
          if (match) {
            return { match_: match[0], remainder: input.substr(match[0].length) };
          }
          return null;
        },
        'uprightEntities': /^(?:pH|pOH|pC|pK|iPr|iBu)(?=$|[^a-zA-Z])/,
        '/': /^\s*(\/)\s*/,
        '//': /^\s*(\/\/)\s*/,
        '*': /^\s*[*.]\s*/
      },
      findObserveGroups: function (
        input: string,
        begExcl: PatternDelimiter,
        begIncl: PatternDelimiter,
        endIncl: PatternDelimiter,
        endExcl: PatternDelimiter,
        beg2Excl?: PatternDelimiter,
        beg2Incl?: PatternDelimiter,
        end2Incl?: PatternDelimiter,
        end2Excl?: PatternDelimiter,
        combine?: boolean
      ): PatternMatch | null {
        const _match = function (
          input: string,
          pattern: PatternDelimiter
        ): string | null {
          if (typeof pattern === "string") {
            if (input.indexOf(pattern) !== 0) { return null; }
            return pattern;
          } else {
            const match = input.match(pattern);
            if (!match) { return null; }
            return match[0] ?? null;
          }
        };
        const _findObserveGroups = function (
          input: string,
          i: number,
          endChars: PatternDelimiter
        ): { endMatchBegin: number, endMatchEnd: number } | null {
          let braces = 0;
          while (i < input.length) {
            const a = input.charAt(i);
            const match = _match(input.substr(i), endChars);
            if (match !== null  &&  braces === 0) {
              return { endMatchBegin: i, endMatchEnd: i + match.length };
            } else if (a === "{") {
              braces++;
            } else if (a === "}") {
              if (braces === 0) {
                throw ["ExtraCloseMissingOpen", "Extra close brace or missing open brace"];
              } else {
                braces--;
              }
            }
            i++;
          }
          return null;
        };
        let match = _match(input, begExcl);
        if (match === null) { return null; }
        input = input.substr(match.length);
        match = _match(input, begIncl);
        if (match === null) { return null; }
        const e = _findObserveGroups(input, match.length, endIncl || endExcl);
        if (e === null) { return null; }
        const match1 = input.substring(0, (endIncl ? e.endMatchEnd : e.endMatchBegin));
        if (!(beg2Excl || beg2Incl)) {
          return {
            match_: match1,
            remainder: input.substr(e.endMatchEnd)
          };
        }
        if (
          beg2Excl === undefined ||
          beg2Incl === undefined ||
          end2Incl === undefined ||
          end2Excl === undefined
        ) {
          throw new Error('mhchem second group delimiters are incomplete')
        }
        const group2 = this.findObserveGroups(
          input.substr(e.endMatchEnd),
          beg2Excl,
          beg2Incl,
          end2Incl,
          end2Excl
        );
        if (group2 === null) { return null; }
        const secondMatch = requireMatchText(group2.match_, 'findObserveGroups')
        const matchRet: string[] = [match1, secondMatch];
        return {
          match_: (combine ? matchRet.join("") : matchRet),
          remainder: group2.remainder
        };
      },

      //
      // Matching function
      // e.g. match("a", input) will look for the regexp called "a" and see if it matches
      // returns null or {match_:"a", remainder:"bc"}
      //
      match_: function (m, input) {
        const pattern = mhchemParser.patterns.patterns[m];
        if (pattern === undefined) {
          throw ["MhchemBugP", "mhchem bug P. Please report. (" + m + ")"];  // Trying to use non-existing pattern
        } else if (typeof pattern === "function") {
          return pattern(input);
        } else {  // RegExp
          const match = input.match(pattern);
          if (match) {
            let mm;
            if (match[2]) {
              mm = [ match[1], match[2] ];
            } else if (match[1]) {
              mm = match[1];
            } else {
              mm = match[0];
            }
            return { match_: mm, remainder: input.substr(match[0].length) };
          }
          return null;
        }
      }
    },

    //
    // Generic state machine actions
    //
    actions: {
      'a=': function (buffer, m) { buffer.a = (buffer.a || "") + requireMatchText(m, 'a='); },
      'b=': function (buffer, m) { buffer.b = (buffer.b || "") + requireMatchText(m, 'b='); },
      'p=': function (buffer, m) { buffer.p = (buffer.p || "") + requireMatchText(m, 'p='); },
      'o=': function (buffer, m) { buffer.o = (buffer.o || "") + requireMatchText(m, 'o='); },
      'q=': function (buffer, m) { buffer.q = (buffer.q || "") + requireMatchText(m, 'q='); },
      'd=': function (buffer, m) { buffer.d = (buffer.d || "") + requireMatchText(m, 'd='); },
      'rm=': function (buffer, m) { buffer.rm = (buffer.rm || "") + requireMatchText(m, 'rm='); },
      'text=': function (buffer, m) { buffer.text_ = (buffer.text_ || "") + requireMatchText(m, 'text='); },
      'insert': function (buffer, m, a): TypeOnlyOutput {
        return { type_: requireTypeOnlyOutputKind(a) };
      },
      'insert+p1': function (buffer, m, a): ScalarOutput {
        return {
          type_: requireScalarOutputKind(a),
          p1: requireMatchText(m, 'insert+p1')
        };
      },
      'copy': function (buffer, m) { return requireMatchText(m, 'copy'); },
      'rm': function (buffer, m): ScalarOutput {
        return { type_: 'rm', p1: requireMatchText(m, 'rm') };
      },
      'text': function (buffer, m) {
        return mhchemParser.go(requireMatchText(m, 'text'), 'text');
      },
      '{text}': function (buffer, m) {
        const ret: ParserOutput[] = [ "{" ];
        mhchemParser.concatArray(ret, mhchemParser.go(requireMatchText(m, '{text}'), 'text'));
        ret.push("}");
        return ret;
      },
      'tex-math': function (buffer, m) {
        return mhchemParser.go(requireMatchText(m, 'tex-math'), 'tex-math');
      },
      'tex-math tight': function (buffer, m) {
        return mhchemParser.go(requireMatchText(m, 'tex-math tight'), 'tex-math tight');
      },
      'bond': function (buffer, m, k): BondOutput {
        return { type_: 'bond', kind_: requireBondKind(k || m) };
      },
      'color0-output': function (buffer, m): ColorDeclarationOutput {
        const color = Array.isArray(m) ? m[0] : m
        if (color === undefined) {
          throw new Error('mhchem color declaration is empty')
        }
        return { type_: 'color0', color };
      },
      'ce': function (buffer, m) {
        return mhchemParser.go(requireMatchText(m, 'ce'));
      },
      '1/2': function (buffer, m) {
        let fraction = requireMatchText(m, '1/2')
        const ret: ParserOutput[] = [];
        if (fraction.match(/^[+-]/)) {
          ret.push(fraction.substr(0, 1));
          fraction = fraction.substr(1);
        }
        const n = fraction.match(/^([0-9]+|\$[a-z]\$|[a-z])\/([0-9]+)(\$[a-z]\$|[a-z])?$/);
        const numerator = n?.[1]
        const denominator = n?.[2]
        if (!numerator || !denominator) {
          throw new Error('mhchem fraction match is incomplete')
        }
        ret.push({
          type_: 'frac',
          p1: numerator.replace(/\$/g, ""),
          p2: denominator
        });
        const suffix = n?.[3]
        if (suffix) {
          ret.push({ type_: 'tex-math', p1: suffix.replace(/\$/g, "") });
        }
        return ret;
      },
      '9,9': function (buffer, m) {
        return mhchemParser.go(requireMatchText(m, '9,9'), '9,9');
      }
    },
    //
    // createTransitions
    // convert  { 'letter': { 'state': { action_: 'output' } } }  to  { 'state' => [ { pattern: 'letter', task: { action_: [{type_: 'output'}] } } ] }
    // with expansion of 'a|b' to 'a' and 'b' (at 2 places)
    //
    createTransitions: function (o) {
      let pattern, state;
      let stateArray: string[];
      const transitions: Transitions = {};
      for (pattern in o) {
        const stateDefinitions = o[pattern]
        if (!stateDefinitions) {
          continue
        }
        for (state in stateDefinitions) {
          stateArray = state.split("|");
          for (const stateName of stateArray) {
            transitions[stateName] = [];
          }
        }
      }
      for (pattern in o) {
        const stateDefinitions = o[pattern]
        if (!stateDefinitions) {
          continue
        }
        for (state in stateDefinitions) {
          const definition = stateDefinitions[state]
          if (!definition) {
            continue
          }
          stateArray = state.split("|");
          const actionDefinitions = definition.action_ === undefined
            ? []
            : Array.isArray(definition.action_)
              ? definition.action_
              : [definition.action_]
          const actions: ActionDescriptor[] = []
          for (const actionDefinition of actionDefinitions) {
            actions.push(typeof actionDefinition === 'string'
              ? { type_: actionDefinition }
              : actionDefinition)
          }
          const task: TransitionTask = { action_: actions }
          if (definition.nextState !== undefined) {
            task.nextState = definition.nextState
          }
          if (definition.revisit !== undefined) {
            task.revisit = definition.revisit
          }
          if (definition.toContinue !== undefined) {
            task.toContinue = definition.toContinue
          }
          const patternArray = pattern.split("|");
          for (const stateName of stateArray) {
            for (const patternName of patternArray) {
              if (stateName === '*') {
                for (const transitionState in transitions) {
                  const stateTransitions = transitions[transitionState]
                  if (stateTransitions) {
                    stateTransitions.push({ pattern: patternName, task });
                  }
                }
              } else {
                const stateTransitions = transitions[stateName]
                if (!stateTransitions) {
                  throw new Error('mhchem transition state is not initialized: ' + stateName)
                }
                stateTransitions.push({ pattern: patternName, task });
              }
            }
          }
        }
      }
      return transitions;
    },
    stateMachines: {}
  };

  //
  // Definition of state machines
  //
  mhchemParser.stateMachines = {
    //
    // \ce state machines
    //
    //#region ce
    'ce': {  // main parser
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': { action_: 'output' } },
        'else':  {
          '0|1|2': { action_: 'beginsWithBond=false', revisit: true, toContinue: true } },
        'oxidation$': {
          '0': { action_: 'oxidation-output' } },
        'CMT': {
          'r': { action_: 'rdt=', nextState: 'rt' },
          'rd': { action_: 'rqt=', nextState: 'rdt' } },
        'arrowUpDown': {
          '0|1|2|as': { action_: [ 'sb=false', 'output', 'operator' ], nextState: '1' } },
        'uprightEntities': {
          '0|1|2': { action_: [ 'o=', 'output' ], nextState: '1' } },
        'orbital': {
          '0|1|2|3': { action_: 'o=', nextState: 'o' } },
        '->': {
          '0|1|2|3': { action_: 'r=', nextState: 'r' },
          'a|as': { action_: [ 'output', 'r=' ], nextState: 'r' },
          '*': { action_: [ 'output', 'r=' ], nextState: 'r' } },
        '+': {
          'o': { action_: 'd= kv',  nextState: 'd' },
          'd|D': { action_: 'd=', nextState: 'd' },
          'q': { action_: 'd=',  nextState: 'qd' },
          'qd|qD': { action_: 'd=', nextState: 'qd' },
          'dq': { action_: [ 'output', 'd=' ], nextState: 'd' },
          '3': { action_: [ 'sb=false', 'output', 'operator' ], nextState: '0' } },
        'amount': {
          '0|2': { action_: 'a=', nextState: 'a' } },
        'pm-operator': {
          '0|1|2|a|as': { action_: [ 'sb=false', 'output', { type_: 'operator', option: '\\pm' } ], nextState: '0' } },
        'operator': {
          '0|1|2|a|as': { action_: [ 'sb=false', 'output', 'operator' ], nextState: '0' } },
        '-$': {
          'o|q': { action_: [ 'charge or bond', 'output' ],  nextState: 'qd' },
          'd': { action_: 'd=', nextState: 'd' },
          'D': { action_: [ 'output', { type_: 'bond', option: "-" } ], nextState: '3' },
          'q': { action_: 'd=',  nextState: 'qd' },
          'qd': { action_: 'd=', nextState: 'qd' },
          'qD|dq': { action_: [ 'output', { type_: 'bond', option: "-" } ], nextState: '3' } },
        '-9': {
          '3|o': { action_: [ 'output', { type_: 'insert', option: 'hyphen' } ], nextState: '3' } },
        '- orbital overlap': {
          'o': { action_: [ 'output', { type_: 'insert', option: 'hyphen' } ], nextState: '2' },
          'd': { action_: [ 'output', { type_: 'insert', option: 'hyphen' } ], nextState: '2' } },
        '-': {
          '0|1|2': { action_: [ { type_: 'output', option: 1 }, 'beginsWithBond=true', { type_: 'bond', option: "-" } ], nextState: '3' },
          '3': { action_: { type_: 'bond', option: "-" } },
          'a': { action_: [ 'output', { type_: 'insert', option: 'hyphen' } ], nextState: '2' },
          'as': { action_: [ { type_: 'output', option: 2 }, { type_: 'bond', option: "-" } ], nextState: '3' },
          'b': { action_: 'b=' },
          'o': { action_: { type_: '- after o/d', option: false }, nextState: '2' },
          'q': { action_: { type_: '- after o/d', option: false }, nextState: '2' },
          'd|qd|dq': { action_: { type_: '- after o/d', option: true }, nextState: '2' },
          'D|qD|p': { action_: [ 'output', { type_: 'bond', option: "-" } ], nextState: '3' } },
        'amount2': {
          '1|3': { action_: 'a=', nextState: 'a' } },
        'letters': {
          '0|1|2|3|a|as|b|p|bp|o': { action_: 'o=', nextState: 'o' },
          'q|dq': { action_: ['output', 'o='], nextState: 'o' },
          'd|D|qd|qD': { action_: 'o after d', nextState: 'o' } },
        'digits': {
          'o': { action_: 'q=', nextState: 'q' },
          'd|D': { action_: 'q=', nextState: 'dq' },
          'q': { action_: [ 'output', 'o=' ], nextState: 'o' },
          'a': { action_: 'o=', nextState: 'o' } },
        'space A': {
          'b|p|bp': {} },
        'space': {
          'a': { nextState: 'as' },
          '0': { action_: 'sb=false' },
          '1|2': { action_: 'sb=true' },
          'r|rt|rd|rdt|rdq': { action_: 'output', nextState: '0' },
          '*': { action_: [ 'output', 'sb=true' ], nextState: '1'} },
        '1st-level escape': {
          '1|2': { action_: [ 'output', { type_: 'insert+p1', option: '1st-level escape' } ] },
          '*': { action_: [ 'output', { type_: 'insert+p1', option: '1st-level escape' } ], nextState: '0' } },
        '[(...)]': {
          'r|rt': { action_: 'rd=', nextState: 'rd' },
          'rd|rdt': { action_: 'rq=', nextState: 'rdq' } },
        '...': {
          'o|d|D|dq|qd|qD': { action_: [ 'output', { type_: 'bond', option: "..." } ], nextState: '3' },
          '*': { action_: [ { type_: 'output', option: 1 }, { type_: 'insert', option: 'ellipsis' } ], nextState: '1' } },
        '. |* ': {
          '*': { action_: [ 'output', { type_: 'insert', option: 'addition compound' } ], nextState: '1' } },
        'state of aggregation $': {
          '*': { action_: [ 'output', 'state of aggregation' ], nextState: '1' } },
        '{[(': {
          'a|as|o': { action_: [ 'o=', 'output', 'parenthesisLevel++' ], nextState: '2' },
          '0|1|2|3': { action_: [ 'o=', 'output', 'parenthesisLevel++' ], nextState: '2' },
          '*': { action_: [ 'output', 'o=', 'output', 'parenthesisLevel++' ], nextState: '2' } },
        ')]}': {
          '0|1|2|3|b|p|bp|o': { action_: [ 'o=', 'parenthesisLevel--' ], nextState: 'o' },
          'a|as|d|D|q|qd|qD|dq': { action_: [ 'output', 'o=', 'parenthesisLevel--' ], nextState: 'o' } },
        ', ': {
          '*': { action_: [ 'output', 'comma' ], nextState: '0' } },
        '^_': {  // ^ and _ without a sensible argument
          '*': { } },
        '^{(...)}|^($...$)': {
          '0|1|2|as': { action_: 'b=', nextState: 'b' },
          'p': { action_: 'b=', nextState: 'bp' },
          '3|o': { action_: 'd= kv', nextState: 'D' },
          'q': { action_: 'd=', nextState: 'qD' },
          'd|D|qd|qD|dq': { action_: [ 'output', 'd=' ], nextState: 'D' } },
        '^a|^\\x{}{}|^\\x{}|^\\x|\'': {
          '0|1|2|as': { action_: 'b=', nextState: 'b' },
          'p': { action_: 'b=', nextState: 'bp' },
          '3|o': { action_: 'd= kv', nextState: 'd' },
          'q': { action_: 'd=', nextState: 'qd' },
          'd|qd|D|qD': { action_: 'd=' },
          'dq': { action_: [ 'output', 'd=' ], nextState: 'd' } },
        '_{(state of aggregation)}$': {
          'd|D|q|qd|qD|dq': { action_: [ 'output', 'q=' ], nextState: 'q' } },
        '_{(...)}|_($...$)|_9|_\\x{}{}|_\\x{}|_\\x': {
          '0|1|2|as': { action_: 'p=', nextState: 'p' },
          'b': { action_: 'p=', nextState: 'bp' },
          '3|o': { action_: 'q=', nextState: 'q' },
          'd|D': { action_: 'q=', nextState: 'dq' },
          'q|qd|qD|dq': { action_: [ 'output', 'q=' ], nextState: 'q' } },
        '=<>': {
          '0|1|2|3|a|as|o|q|d|D|qd|qD|dq': { action_: [ { type_: 'output', option: 2 }, 'bond' ], nextState: '3' } },
        '#': {
          '0|1|2|3|a|as|o': { action_: [ { type_: 'output', option: 2 }, { type_: 'bond', option: "#" } ], nextState: '3' } },
        '{}': {
          '*': { action_: { type_: 'output', option: 1 },  nextState: '1' } },
        '{...}': {
          '0|1|2|3|a|as|b|p|bp': { action_: 'o=', nextState: 'o' },
          'o|d|D|q|qd|qD|dq': { action_: [ 'output', 'o=' ], nextState: 'o' } },
        '$...$': {
          'a': { action_: 'a=' },  // 2$n$
          '0|1|2|3|as|b|p|bp|o': { action_: 'o=', nextState: 'o' },  // not 'amount'
          'as|o': { action_: 'o=' },
          'q|d|D|qd|qD|dq': { action_: [ 'output', 'o=' ], nextState: 'o' } },
        '\\bond{(...)}': {
          '*': { action_: [ { type_: 'output', option: 2 }, 'bond' ], nextState: "3" } },
        '\\frac{(...)}': {
          '*': { action_: [ { type_: 'output', option: 1 }, 'frac-output' ], nextState: '3' } },
        '\\overset{(...)}': {
          '*': { action_: [ { type_: 'output', option: 2 }, 'overset-output' ], nextState: '3' } },
        '\\underset{(...)}': {
          '*': { action_: [ { type_: 'output', option: 2 }, 'underset-output' ], nextState: '3' } },
        '\\underbrace{(...)}': {
          '*': { action_: [ { type_: 'output', option: 2 }, 'underbrace-output' ], nextState: '3' } },
        '\\color{(...)}{(...)}1|\\color(...){(...)}2': {
          '*': { action_: [ { type_: 'output', option: 2 }, 'color-output' ], nextState: '3' } },
        '\\color{(...)}0': {
          '*': { action_: [ { type_: 'output', option: 2 }, 'color0-output' ] } },
        '\\ce{(...)}': {
          '*': { action_: [ { type_: 'output', option: 2 }, 'ce' ], nextState: '3' } },
        '\\,': {
          '*': { action_: [ { type_: 'output', option: 1 }, 'copy' ], nextState: '1' } },
        '\\x{}{}|\\x{}|\\x': {
          '0|1|2|3|a|as|b|p|bp|o|c0': { action_: [ 'o=', 'output' ], nextState: '3' },
          '*': { action_: ['output', 'o=', 'output' ], nextState: '3' } },
        'others': {
          '*': { action_: [ { type_: 'output', option: 1 }, 'copy' ], nextState: '3' } },
        'else2': {
          'a': { action_: 'a to o', nextState: 'o', revisit: true },
          'as': { action_: [ 'output', 'sb=true' ], nextState: '1', revisit: true },
          'r|rt|rd|rdt|rdq': { action_: [ 'output' ], nextState: '0', revisit: true },
          '*': { action_: [ 'output', 'copy' ], nextState: '3' } }
      }),
      actions: {
        'o after d': function (buffer, m) {
          let ret: ParserOutput | ParserOutput[] | void;
          if ((buffer.d || "").match(/^[0-9]+$/)) {
            const tmp = buffer.d;
            buffer.d = undefined;
            ret = invokeParserAction(this, 'output', buffer);
            buffer.b = tmp;
          } else {
            ret = invokeParserAction(this, 'output', buffer);
          }
          invokeParserAction(mhchemParser.actions, 'o=', buffer, m);
          return ret;
        },
        'd= kv': function (buffer, m) {
          buffer.d = requireMatchText(m, 'd= kv');
          buffer.dType = 'kv';
        },
        'charge or bond': function (buffer, m) {
          if (buffer['beginsWithBond']) {
            const ret: ParserOutput[] = [];
            mhchemParser.concatArray(ret, invokeParserAction(this, 'output', buffer));
            mhchemParser.concatArray(
              ret,
              invokeParserAction(mhchemParser.actions, 'bond', buffer, m, "-")
            );
            return ret;
          } else {
            buffer.d = requireMatchText(m, 'charge or bond');
          }
        },
        '- after o/d': function (buffer, m, isAfterD) {
          const text = requireMatchText(m, '- after o/d')
          let c1 = mhchemParser.patterns.match_('orbital', buffer.o || "");
          const c2 = mhchemParser.patterns.match_('one lowercase greek letter $', buffer.o || "");
          const c3 = mhchemParser.patterns.match_('one lowercase latin letter $', buffer.o || "");
          const c4 = mhchemParser.patterns.match_('$one lowercase latin letter$ $', buffer.o || "");
          const hyphenFollows = text === "-" && Boolean(
            c1 && c1.remainder === "" || c2 || c3 || c4
          );
          if (hyphenFollows && !buffer.a && !buffer.b && !buffer.p && !buffer.d && !buffer.q && !c1 && c3) {
            buffer.o = '$' + buffer.o + '$';
          }
          const ret: ParserOutput[] = [];
          if (hyphenFollows) {
            mhchemParser.concatArray(ret, invokeParserAction(this, 'output', buffer));
            ret.push({ type_: 'hyphen' });
          } else {
            c1 = mhchemParser.patterns.match_('digits', buffer.d || "");
            if (isAfterD && c1 && c1.remainder === '') {
              invokeParserAction(mhchemParser.actions, 'd=', buffer, text);
              mhchemParser.concatArray(ret, invokeParserAction(this, 'output', buffer));
            } else {
              mhchemParser.concatArray(ret, invokeParserAction(this, 'output', buffer));
              mhchemParser.concatArray(
                ret,
                invokeParserAction(mhchemParser.actions, 'bond', buffer, text, "-")
              );
            }
          }
          return ret;
        },
        'a to o': function (buffer) {
          buffer.o = buffer.a;
          buffer.a = undefined;
        },
        'sb=true': function (buffer) { buffer.sb = true; },
        'sb=false': function (buffer) { buffer.sb = false; },
        'beginsWithBond=true': function (buffer) { buffer['beginsWithBond'] = true; },
        'beginsWithBond=false': function (buffer) { buffer['beginsWithBond'] = false; },
        'parenthesisLevel++': function (buffer) { buffer['parenthesisLevel']++; },
        'parenthesisLevel--': function (buffer) { buffer['parenthesisLevel']--; },
        'state of aggregation': function (buffer: ParserBuffer, m: string): NestedOutput {
          return { type_: 'state of aggregation', p1: mhchemParser.go(m, 'o') };
        },
        'comma': function (buffer: ParserBuffer, m: string): ScalarOutput {
          const a = m.replace(/\s*$/, '');
          const withSpace = (a !== m);
          if (withSpace  &&  buffer['parenthesisLevel'] === 0) {
            return { type_: 'comma enumeration L', p1: a };
          } else {
            return { type_: 'comma enumeration M', p1: a };
          }
        },
        'output': function (buffer: ParserBuffer, m: MatchValue, entityFollows?: 1 | 2): ParserOutput | ParserOutput[] {
          // entityFollows:
          //   undefined = if we have nothing else to output, also ignore the just read space (buffer.sb)
          //   1 = an entity follows, never omit the space if there was one just read before (can only apply to state 1)
          //   2 = 1 + the entity can have an amount, so output a\, instead of converting it to o (can only apply to states a|as)
          let ret: ParserOutput | ParserOutput[];
          if (!buffer.r) {
            ret = [];
            if (!buffer.a && !buffer.b && !buffer.p && !buffer.o && !buffer.q && !buffer.d && !entityFollows) {
              //ret = [];
            } else {
              if (buffer.sb) {
                ret.push({ type_: 'entitySkip' });
              }
              if (!buffer.o && !buffer.q && !buffer.d && !buffer.b && !buffer.p && entityFollows!==2) {
                buffer.o = buffer.a;
                buffer.a = undefined;
              } else if (!buffer.o && !buffer.q && !buffer.d && (buffer.b || buffer.p)) {
                buffer.o = buffer.a;
                buffer.d = buffer.b;
                buffer.q = buffer.p;
                buffer.a = buffer.b = buffer.p = undefined;
              } else {
                if (buffer.o && buffer.dType==='kv' && mhchemParser.patterns.match_('d-oxidation$', buffer.d || "")) {
                  buffer.dType = 'oxidation';
                } else if (buffer.o && buffer.dType==='kv' && !buffer.q) {
                  buffer.dType = undefined;
                }
              }
              ret.push({
                type_: 'chemfive',
                a: mhchemParser.go(buffer.a, 'a'),
                b: mhchemParser.go(buffer.b, 'bd'),
                p: mhchemParser.go(buffer.p, 'pq'),
                o: mhchemParser.go(buffer.o, 'o'),
                q: mhchemParser.go(buffer.q, 'pq'),
                d: mhchemParser.go(buffer.d, (buffer.dType === 'oxidation' ? 'oxidation' : 'bd')),
                dType: buffer.dType
              });
            }
          } else {  // r
            let rd: ParserOutput[];
            if (buffer.rdt === 'M') {
              rd = mhchemParser.go(buffer.rd, 'tex-math');
            } else if (buffer.rdt === 'T') {
              rd = [ { type_: 'text', p1: buffer.rd || "" } ];
            } else {
              rd = mhchemParser.go(buffer.rd);
            }
            let rq: ParserOutput[];
            if (buffer.rqt === 'M') {
              rq = mhchemParser.go(buffer.rq, 'tex-math');
            } else if (buffer.rqt === 'T') {
              rq = [ { type_: 'text', p1: buffer.rq || ""} ];
            } else {
              rq = mhchemParser.go(buffer.rq);
            }
            ret = {
              type_: 'arrow',
              r: buffer.r,
              rd: rd,
              rq: rq
            };
          }
          for (const p in buffer) {
            if (p !== 'parenthesisLevel'  &&  p !== 'beginsWithBond') {
              delete buffer[p];
            }
          }
          return ret;
        },
        'oxidation-output': function (buffer: ParserBuffer, m: string): ParserOutput[] {
          const ret: ParserOutput[] = [ "{" ];
          mhchemParser.concatArray(ret, mhchemParser.go(m, 'oxidation'));
          ret.push("}");
          return ret;
        },
        'frac-output': function (buffer: ParserBuffer, m: [string, string]): NestedPairOutput {
          return { type_: 'frac-ce', p1: mhchemParser.go(m[0]), p2: mhchemParser.go(m[1]) };
        },
        'overset-output': function (buffer: ParserBuffer, m: [string, string]): NestedPairOutput {
          return { type_: 'overset', p1: mhchemParser.go(m[0]), p2: mhchemParser.go(m[1]) };
        },
        'underset-output': function (buffer: ParserBuffer, m: [string, string]): NestedPairOutput {
          return { type_: 'underset', p1: mhchemParser.go(m[0]), p2: mhchemParser.go(m[1]) };
        },
        'underbrace-output': function (buffer: ParserBuffer, m: [string, string]): NestedPairOutput {
          return { type_: 'underbrace', p1: mhchemParser.go(m[0]), p2: mhchemParser.go(m[1]) };
        },
        'color-output': function (buffer: ParserBuffer, m: [string, string]): ColorOutput {
          return { type_: 'color', color1: m[0], color2: mhchemParser.go(m[1]) };
        },
        'r=': function (buffer: ParserBuffer, m: ArrowKind): void { buffer.r = m; },
        'rdt=': function (buffer: ParserBuffer, m: string): void { buffer.rdt = m; },
        'rd=': function (buffer: ParserBuffer, m: string): void { buffer.rd = m; },
        'rqt=': function (buffer: ParserBuffer, m: string): void { buffer.rqt = m; },
        'rq=': function (buffer: ParserBuffer, m: string): void { buffer.rq = m; },
        'operator': function (buffer: ParserBuffer, m: OperatorKind, p1?: OperatorKind): OperatorOutput { return { type_: 'operator', kind_: (p1 || m) }; }
      }
    },
    'a': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': {} },
        '1/2$': {
          '0': { action_: '1/2' } },
        'else': {
          '0': { nextState: '1', revisit: true } },
        '$(...)$': {
          '*': { action_: 'tex-math tight', nextState: '1' } },
        ',': {
          '*': { action_: { type_: 'insert', option: 'commaDecimal' } } },
        'else2': {
          '*': { action_: 'copy' } }
      }),
      actions: {}
    },
    'o': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': {} },
        '1/2$': {
          '0': { action_: '1/2' } },
        'else': {
          '0': { nextState: '1', revisit: true } },
        'letters': {
          '*': { action_: 'rm' } },
        '\\ca': {
          '*': { action_: { type_: 'insert', option: 'circa' } } },
        '\\x{}{}|\\x{}|\\x': {
          '*': { action_: 'copy' } },
        '${(...)}$|$(...)$': {
          '*': { action_: 'tex-math' } },
        '{(...)}': {
          '*': { action_: '{text}' } },
        'else2': {
          '*': { action_: 'copy' } }
      }),
      actions: {}
    },
    'text': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': { action_: 'output' } },
        '{...}': {
          '*': { action_: 'text=' } },
        '${(...)}$|$(...)$': {
          '*': { action_: 'tex-math' } },
        '\\greek': {
          '*': { action_: [ 'output', 'rm' ] } },
        '\\,|\\x{}{}|\\x{}|\\x': {
          '*': { action_: [ 'output', 'copy' ] } },
        'else': {
          '*': { action_: 'text=' } }
      }),
      actions: {
        'output': function (buffer: ParserBuffer): ScalarOutput | undefined {
          if (buffer.text_) {
            const ret: ScalarOutput = { type_: 'text', p1: buffer.text_ };
            for (const p in buffer) { delete buffer[p]; }
            return ret;
          }
        }
      }
    },
    'pq': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': {} },
        'state of aggregation $': {
          '*': { action_: 'state of aggregation' } },
        'i$': {
          '0': { nextState: '!f', revisit: true } },
        '(KV letters),': {
          '0': { action_: 'rm', nextState: '0' } },
        'formula$': {
          '0': { nextState: 'f', revisit: true } },
        '1/2$': {
          '0': { action_: '1/2' } },
        'else': {
          '0': { nextState: '!f', revisit: true } },
        '${(...)}$|$(...)$': {
          '*': { action_: 'tex-math' } },
        '{(...)}': {
          '*': { action_: 'text' } },
        'a-z': {
          'f': { action_: 'tex-math' } },
        'letters': {
          '*': { action_: 'rm' } },
        '-9.,9': {
          '*': { action_: '9,9'  } },
        ',': {
          '*': { action_: { type_: 'insert+p1', option: 'comma enumeration S' } } },
        '\\color{(...)}{(...)}1|\\color(...){(...)}2': {
          '*': { action_: 'color-output' } },
        '\\color{(...)}0': {
          '*': { action_: 'color0-output' } },
        '\\ce{(...)}': {
          '*': { action_: 'ce' } },
        '\\,|\\x{}{}|\\x{}|\\x': {
          '*': { action_: 'copy' } },
        'else2': {
          '*': { action_: 'copy' } }
      }),
      actions: {
        'state of aggregation': function (buffer: ParserBuffer, m: string): NestedOutput {
          return { type_: 'state of aggregation subscript', p1: mhchemParser.go(m, 'o') };
        },
        'color-output': function (buffer: ParserBuffer, m: [string, string]): ColorOutput {
          return { type_: 'color', color1: m[0], color2: mhchemParser.go(m[1], 'pq') };
        }
      }
    },
    'bd': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': {} },
        'x$': {
          '0': { nextState: '!f', revisit: true } },
        'formula$': {
          '0': { nextState: 'f', revisit: true } },
        'else': {
          '0': { nextState: '!f', revisit: true } },
        '-9.,9 no missing 0': {
          '*': { action_: '9,9' } },
        '.': {
          '*': { action_: { type_: 'insert', option: 'electron dot' } } },
        'a-z': {
          'f': { action_: 'tex-math' } },
        'x': {
          '*': { action_: { type_: 'insert', option: 'KV x' } } },
        'letters': {
          '*': { action_: 'rm' } },
        '\'': {
          '*': { action_: { type_: 'insert', option: 'prime' } } },
        '${(...)}$|$(...)$': {
          '*': { action_: 'tex-math' } },
        '{(...)}': {
          '*': { action_: 'text' } },
        '\\color{(...)}{(...)}1|\\color(...){(...)}2': {
          '*': { action_: 'color-output' } },
        '\\color{(...)}0': {
          '*': { action_: 'color0-output' } },
        '\\ce{(...)}': {
          '*': { action_: 'ce' } },
        '\\,|\\x{}{}|\\x{}|\\x': {
          '*': { action_: 'copy' } },
        'else2': {
          '*': { action_: 'copy' } }
      }),
      actions: {
        'color-output': function (buffer: ParserBuffer, m: [string, string]): ColorOutput {
          return { type_: 'color', color1: m[0], color2: mhchemParser.go(m[1], 'bd') };
        }
      }
    },
    'oxidation': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': {} },
        'roman numeral': {
          '*': { action_: 'roman-numeral' } },
        '${(...)}$|$(...)$': {
          '*': { action_: 'tex-math' } },
        'else': {
          '*': { action_: 'copy' } }
      }),
      actions: {
        'roman-numeral': function (buffer: ParserBuffer, m: string): ScalarOutput { return { type_: 'roman numeral', p1: m || "" }; }
      }
    },
    'tex-math': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': { action_: 'output' } },
        '\\ce{(...)}': {
          '*': { action_: [ 'output', 'ce' ] } },
        '{...}|\\,|\\x{}{}|\\x{}|\\x': {
          '*': { action_: 'o=' } },
        'else': {
          '*': { action_: 'o=' } }
      }),
      actions: {
        'output': function (buffer: ParserBuffer): MathOutput | undefined {
          if (buffer.o) {
            const ret: MathOutput = { type_: 'tex-math', p1: buffer.o };
            for (const p in buffer) { delete buffer[p]; }
            return ret;
          }
        }
      }
    },
    'tex-math tight': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': { action_: 'output' } },
        '\\ce{(...)}': {
          '*': { action_: [ 'output', 'ce' ] } },
        '{...}|\\,|\\x{}{}|\\x{}|\\x': {
          '*': { action_: 'o=' } },
        '-|+': {
          '*': { action_: 'tight operator' } },
        'else': {
          '*': { action_: 'o=' } }
      }),
      actions: {
        'tight operator': function (buffer: ParserBuffer, m: string): void { buffer.o = (buffer.o || "") + "{"+m+"}"; },
        'output': function (buffer: ParserBuffer): MathOutput | undefined {
          if (buffer.o) {
            const ret: MathOutput = { type_: 'tex-math', p1: buffer.o };
            for (const p in buffer) { delete buffer[p]; }
            return ret;
          }
        }
      }
    },
    '9,9': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': {} },
        ',': {
          '*': { action_: 'comma' } },
        'else': {
          '*': { action_: 'copy' } }
      }),
      actions: {
        'comma': function () { return { type_: 'commaDecimal' }; }
      }
    },
    //#endregion
    //
    // \pu state machines
    //
    //#region pu
    'pu': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': { action_: 'output' } },
        'space$': {
          '*': { action_: [ 'output', 'space' ] } },
        '{[(|)]}': {
          '0|a': { action_: 'copy' } },
        '(-)(9)^(-9)': {
          '0': { action_: 'number^', nextState: 'a' } },
        '(-)(9.,9)(e)(99)': {
          '0': { action_: 'enumber', nextState: 'a' } },
        'space': {
          '0|a': {} },
        'pm-operator': {
          '0|a': { action_: { type_: 'operator', option: '\\pm' }, nextState: '0' } },
        'operator': {
          '0|a': { action_: 'copy', nextState: '0' } },
        '//': {
          'd': { action_: 'o=', nextState: '/' } },
        '/': {
          'd': { action_: 'o=', nextState: '/' } },
        '{...}|else': {
          '0|d': { action_: 'd=', nextState: 'd' },
          'a': { action_: [ 'space', 'd=' ], nextState: 'd' },
          '/|q': { action_: 'q=', nextState: 'q' } }
      }),
      actions: {
        'enumber': function (buffer: ParserBuffer, m: ScientificNumberMatch): ParserOutput[] {
          const ret: ParserOutput[] = [];
          if (m[0] === "+-"  ||  m[0] === "+/-") {
            ret.push("\\pm ");
          } else if (m[0]) {
            ret.push(m[0]);
          }
          if (m[1]) {
            mhchemParser.concatArray(ret, mhchemParser.go(m[1], 'pu-9,9'));
            if (m[2]) {
              if (m[2].match(/[,.]/)) {
                mhchemParser.concatArray(ret, mhchemParser.go(m[2], 'pu-9,9'));
              } else {
                ret.push(m[2]);
              }
            }
            m[3] = m[4] || m[3];
            if (m[3]) {
              m[3] = m[3].trim();
              if (m[3] === "e"  ||  m[3].substr(0, 1) === "*") {
                ret.push({ type_: 'cdot' });
              } else {
                ret.push({ type_: 'times' });
              }
            }
          }
          if (m[3]) {
            ret.push("10^{"+m[5]+"}");
          }
          return ret;
        },
        'number^': function (buffer: ParserBuffer, m: PowerNumberMatch): ParserOutput[] {
          const ret: ParserOutput[] = [];
          if (m[0] === "+-"  ||  m[0] === "+/-") {
            ret.push("\\pm ");
          } else if (m[0]) {
            ret.push(m[0]);
          }
          mhchemParser.concatArray(ret, mhchemParser.go(m[1], 'pu-9,9'));
          ret.push("^{"+m[2]+"}");
          return ret;
        },
        'operator': function (buffer: ParserBuffer, m: OperatorKind, p1?: OperatorKind): OperatorOutput { return { type_: 'operator', kind_: (p1 || m) }; },
        'space': function (): TypeOnlyOutput { return { type_: 'pu-space-1' }; },
        'output': function (buffer: ParserBuffer): ParserOutput | ParserOutput[] {
          let ret: ParserOutput | ParserOutput[];
          const md = mhchemParser.patterns.match_('{(...)}', buffer.d || "");
          if (md  &&  md.remainder === '' && typeof md.match_ === 'string') { buffer.d = md.match_; }
          const mq = mhchemParser.patterns.match_('{(...)}', buffer.q || "");
          if (mq  &&  mq.remainder === '' && typeof mq.match_ === 'string') { buffer.q = mq.match_; }
          if (buffer.d) {
            buffer.d = buffer.d.replace(/\u00B0C|\^oC|\^{o}C/g, "{}^{\\circ}C");
            buffer.d = buffer.d.replace(/\u00B0F|\^oF|\^{o}F/g, "{}^{\\circ}F");
          }
          if (buffer.q) {  // fraction
            buffer.q = buffer.q.replace(/\u00B0C|\^oC|\^{o}C/g, "{}^{\\circ}C");
            buffer.q = buffer.q.replace(/\u00B0F|\^oF|\^{o}F/g, "{}^{\\circ}F");
            const b5 = {
              d: mhchemParser.go(buffer.d, 'pu'),
              q: mhchemParser.go(buffer.q, 'pu')
            };
            if (buffer.o === '//') {
              ret = { type_: 'pu-frac', p1: b5.d, p2: b5.q };
            } else {
              ret = b5.d;
              if (b5.d.length > 1  ||  b5.q.length > 1) {
                ret.push({ type_: ' / ' });
              } else {
                ret.push({ type_: '/' });
              }
              mhchemParser.concatArray(ret, b5.q);
            }
          } else {  // no fraction
            ret = mhchemParser.go(buffer.d, 'pu-2');
          }
          for (const p in buffer) { delete buffer[p]; }
          return ret;
        }
      }
    },
    'pu-2': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '*': { action_: 'output' } },
        '*': {
          '*': { action_: [ 'output', 'cdot' ], nextState: '0' } },
        '\\x': {
          '*': { action_: 'rm=' } },
        'space': {
          '*': { action_: [ 'output', 'space' ], nextState: '0' } },
        '^{(...)}|^(-1)': {
          '1': { action_: '^(-1)' } },
        '-9.,9': {
          '0': { action_: 'rm=', nextState: '0' },
          '1': { action_: '^(-1)', nextState: '0' } },
        '{...}|else': {
          '*': { action_: 'rm=', nextState: '1' } }
      }),
      actions: {
        'cdot': function (): TypeOnlyOutput { return { type_: 'tight cdot' }; },
        '^(-1)': function (buffer: ParserBuffer & { rm: string }, m: string): void { buffer.rm += "^{"+m+"}"; },
        'space': function (): TypeOnlyOutput { return { type_: 'pu-space-2' }; },
        'output': function (buffer: ParserBuffer): ParserOutput | ParserOutput[] {
          let ret: ParserOutput | ParserOutput[] = [];
          if (buffer.rm) {
            const mrm = mhchemParser.patterns.match_('{(...)}', buffer.rm || "");
            if (mrm  &&  mrm.remainder === '' && typeof mrm.match_ === 'string') {
              ret = mhchemParser.go(mrm.match_, 'pu');
            } else {
              ret = { type_: 'rm', p1: buffer.rm };
            }
          }
          for (const p in buffer) { delete buffer[p]; }
          return ret;
        }
      }
    },
    'pu-9,9': {
      transitions: mhchemParser.createTransitions({
        'empty': {
          '0': { action_: 'output-0' },
          'o': { action_: 'output-o' } },
        ',': {
          '0': { action_: [ 'output-0', 'comma' ], nextState: 'o' } },
        '.': {
          '0': { action_: [ 'output-0', 'copy' ], nextState: 'o' } },
        'else': {
          '*': { action_: 'text=' } }
      }),
      actions: {
        'comma': function (): TypeOnlyOutput { return { type_: 'commaDecimal' }; },
        'output-0': function (buffer: ParserBuffer): ParserOutput[] {
          const ret: ParserOutput[] = [];
          buffer.text_ = buffer.text_ || "";
          if (buffer.text_.length > 4) {
            let a = buffer.text_.length % 3;
            if (a === 0) { a = 3; }
            for (let i=buffer.text_.length-3; i>0; i-=3) {
              ret.push(buffer.text_.substr(i, 3));
              ret.push({ type_: '1000 separator' });
            }
            ret.push(buffer.text_.substr(0, a));
            ret.reverse();
          } else {
            ret.push(buffer.text_);
          }
          for (const p in buffer) { delete buffer[p]; }
          return ret;
        },
        'output-o': function (buffer: ParserBuffer): ParserOutput[] {
          const ret: ParserOutput[] = [];
          buffer.text_ = buffer.text_ || "";
          if (buffer.text_.length > 4) {
            const a = buffer.text_.length - 3;
            let i = 0;
            for (; i<a; i+=3) {
              ret.push(buffer.text_.substr(i, 3));
              ret.push({ type_: '1000 separator' });
            }
            ret.push(buffer.text_.substr(i));
          } else {
            ret.push(buffer.text_);
          }
          for (const p in buffer) { delete buffer[p]; }
          return ret;
        }
      }
    }
    //#endregion
  };

  //
  // texify: Take MhchemParser output and convert it to TeX
  //
  /** @type {Texify} */
  const texify = {
    go: function (input: ParserOutput[] | undefined, isInner?: boolean): string {  // (recursive, max 4 levels)
      if (!input) { return ""; }
      let res = "";
      let cee = false;
      for (let i=0; i < input.length; i++) {
        const inputi = input[i];
        if (inputi === undefined) {
          continue
        }
        if (typeof inputi === "string") {
          res += inputi;
        } else {
          res += texify._go2(inputi);
          if (inputi.type_ === '1st-level escape') { cee = true; }
        }
      }
      if (!isInner && !cee && res) {
        res = "{" + res + "}";
      }
      return res;
    },
    _goInner: function (input: ParserOutput[] | undefined): string | undefined {
      if (!input) { return input; }
      return texify.go(input, true);
    },
    _go2: function (buf: ParserOutputObject): string {
      let res: string;
      switch (buf.type_) {
        case 'chemfive': {
          res = "";
          const b5 = {
            a: texify._goInner(buf.a),
            b: texify._goInner(buf.b),
            p: texify._goInner(buf.p),
            o: texify._goInner(buf.o),
            q: texify._goInner(buf.q),
            d: texify._goInner(buf.d)
          };
          //
          // a
          //
          if (b5.a) {
            if (b5.a.match(/^[+-]/)) { b5.a = "{"+b5.a+"}"; }
            res += b5.a + "\\,";
          }
          //
          // b and p
          //
          if (b5.b || b5.p) {
            res += "{\\vphantom{X}}";
            res += "^{\\hphantom{"+(b5.b||"")+"}}_{\\hphantom{"+(b5.p||"")+"}}";
            res += "{\\vphantom{X}}";
            res += "^{\\smash[t]{\\vphantom{2}}\\mathllap{"+(b5.b||"")+"}}";
            res += "_{\\vphantom{2}\\mathllap{\\smash[t]{"+(b5.p||"")+"}}}";
          }
          //
          // o
          //
          if (b5.o) {
            if (b5.o.match(/^[+-]/)) { b5.o = "{"+b5.o+"}"; }
            res += b5.o;
          }
          //
          // q and d
          //
          if (buf.dType === 'kv') {
            if (b5.d || b5.q) {
              res += "{\\vphantom{X}}";
            }
            if (b5.d) {
              res += "^{"+b5.d+"}";
            }
            if (b5.q) {
              res += "_{\\smash[t]{"+b5.q+"}}";
            }
          } else if (buf.dType === 'oxidation') {
            if (b5.d) {
              res += "{\\vphantom{X}}";
              res += "^{"+b5.d+"}";
            }
            if (b5.q) {
              res += "{\\vphantom{X}}";
              res += "_{\\smash[t]{"+b5.q+"}}";
            }
          } else {
            if (b5.q) {
              res += "{\\vphantom{X}}";
              res += "_{\\smash[t]{"+b5.q+"}}";
            }
            if (b5.d) {
              res += "{\\vphantom{X}}";
              res += "^{"+b5.d+"}";
            }
          }
          break;
        }
        case 'rm':
          res = "\\mathrm{"+buf.p1+"}";
          break;
        case 'text':
          if (buf.p1.match(/[\^_]/)) {
            buf.p1 = buf.p1.replace(" ", "~").replace("-", "\\text{-}");
            res = "\\mathrm{"+buf.p1+"}";
          } else {
            res = "\\text{"+buf.p1+"}";
          }
          break;
        case 'roman numeral':
          res = "\\mathrm{"+buf.p1+"}";
          break;
        case 'state of aggregation':
          res = "\\mskip2mu "+texify._goInner(buf.p1);
          break;
        case 'state of aggregation subscript':
          res = "\\mskip1mu "+texify._goInner(buf.p1);
          break;
        case 'bond':
          res = texify._getBond(buf.kind_);
          if (!res) {
            throw ["MhchemErrorBond", "mhchem Error. Unknown bond type (" + buf.kind_ + ")"];
          }
          break;
        case 'frac': {
          const c = "\\frac{" + buf.p1 + "}{" + buf.p2 + "}";
          res = "\\mathchoice{\\textstyle"+c+"}{"+c+"}{"+c+"}{"+c+"}";
          break;
        }
        case 'pu-frac': {
          const d = "\\frac{" + texify._goInner(buf.p1) + "}{" + texify._goInner(buf.p2) + "}";
          res = "\\mathchoice{\\textstyle"+d+"}{"+d+"}{"+d+"}{"+d+"}";
          break;
        }
        case 'tex-math':
          res = buf.p1 + " ";
          break;
        case 'frac-ce':
          res = "\\frac{" + texify._goInner(buf.p1) + "}{" + texify._goInner(buf.p2) + "}";
          break;
        case 'overset':
          res = "\\overset{" + texify._goInner(buf.p1) + "}{" + texify._goInner(buf.p2) + "}";
          break;
        case 'underset':
          res = "\\underset{" + texify._goInner(buf.p1) + "}{" + texify._goInner(buf.p2) + "}";
          break;
        case 'underbrace':
          res =  "\\underbrace{" + texify._goInner(buf.p1) + "}_{" + texify._goInner(buf.p2) + "}";
          break;
        case 'color':
          res = "{\\color{" + buf.color1 + "}{" + texify._goInner(buf.color2) + "}}";
          break;
        case 'color0':
          res = "\\color{" + buf.color + "}";
          break;
        case 'arrow': {
          const b6 = {
            rd: texify._goInner(buf.rd),
            rq: texify._goInner(buf.rq)
          };
          let arrow = "\\x" + texify._getArrow(buf.r);
          if (b6.rq) { arrow += "[{" + b6.rq + "}]"; }
          if (b6.rd) {
            arrow += "{" + b6.rd + "}";
          } else {
            arrow += "{}";
          }
          res = arrow;
          break;
        }
        case 'operator':
          res = texify._getOperator(buf.kind_);
          break;
        case '1st-level escape':
          res = buf.p1+" ";  // &, \\\\, \\hlin
          break;
        case 'space':
          res = " ";
          break;
        case 'entitySkip':
          res = "~";
          break;
        case 'pu-space-1':
          res = "~";
          break;
        case 'pu-space-2':
          res = "\\mkern3mu ";
          break;
        case '1000 separator':
          res = "\\mkern2mu ";
          break;
        case 'commaDecimal':
          res = "{,}";
          break;
          case 'comma enumeration L':
          res = "{"+buf.p1+"}\\mkern6mu ";
          break;
        case 'comma enumeration M':
          res = "{"+buf.p1+"}\\mkern3mu ";
          break;
        case 'comma enumeration S':
          res = "{"+buf.p1+"}\\mkern1mu ";
          break;
        case 'hyphen':
          res = "\\text{-}";
          break;
        case 'addition compound':
          res = "\\,{\\cdot}\\,";
          break;
        case 'electron dot':
          res = "\\mkern1mu \\bullet\\mkern1mu ";
          break;
        case 'KV x':
          res = "{\\times}";
          break;
        case 'prime':
          res = "\\prime ";
          break;
        case 'cdot':
          res = "\\cdot ";
          break;
        case 'tight cdot':
          res = "\\mkern1mu{\\cdot}\\mkern1mu ";
          break;
        case 'times':
          res = "\\times ";
          break;
        case 'circa':
          res = "{\\sim}";
          break;
        case '^':
          res = "uparrow";
          break;
        case 'v':
          res = "downarrow";
          break;
        case 'ellipsis':
          res = "\\ldots ";
          break;
        case '/':
          res = "/";
          break;
        case ' / ':
          res = "\\,/\\,";
          break;
        default:
          assertNever(buf);
          throw ["MhchemBugT", "mhchem bug T. Please report."];  // Missing texify rule or unknown MhchemParser output
      }
      assertString(res);
      return res;
    },
    _getArrow: function (a: ArrowKind): string {
      switch (a) {
        case "->": return "rightarrow";
        case "\u2192": return "rightarrow";
        case "\u27F6": return "rightarrow";
        case "<-": return "leftarrow";
        case "<->": return "leftrightarrow";
        case "<-->": return "rightleftarrows";
        case "<=>": return "rightleftharpoons";
        case "\u21CC": return "rightleftharpoons";
        case "<=>>": return "rightequilibrium";
        case "<<=>": return "leftequilibrium";
        default:
          assertNever(a);
          throw ["MhchemBugT", "mhchem bug T. Please report."];
      }
    },
    _getBond: function (a: BondKind): string {
      switch (a) {
        case "-": return "{-}";
        case "1": return "{-}";
        case "=": return "{=}";
        case "2": return "{=}";
        case "#": return "{\\equiv}";
        case "3": return "{\\equiv}";
        case "~": return "{\\tripledash}";
        case "~-": return "{\\mathrlap{\\raisebox{-.1em}{$-$}}\\raisebox{.1em}{$\\tripledash$}}";
        case "~=": return "{\\mathrlap{\\raisebox{-.2em}{$-$}}\\mathrlap{\\raisebox{.2em}{$\\tripledash$}}-}";
        case "~--": return "{\\mathrlap{\\raisebox{-.2em}{$-$}}\\mathrlap{\\raisebox{.2em}{$\\tripledash$}}-}";
        case "-~-": return "{\\mathrlap{\\raisebox{-.2em}{$-$}}\\mathrlap{\\raisebox{.2em}{$-$}}\\tripledash}";
        case "...": return "{{\\cdot}{\\cdot}{\\cdot}}";
        case "....": return "{{\\cdot}{\\cdot}{\\cdot}{\\cdot}}";
        case "->": return "{\\rightarrow}";
        case "<-": return "{\\leftarrow}";
        case "<": return "{<}";
        case ">": return "{>}";
        default:
          assertNever(a);
          throw ["MhchemBugT", "mhchem bug T. Please report."];
      }
    },
    _getOperator: function (a: OperatorKind): string {
      switch (a) {
        case "+": return " {}+{} ";
        case "-": return " {}-{} ";
        case "=": return " {}={} ";
        case "<": return " {}<{} ";
        case ">": return " {}>{} ";
        case "<<": return " {}\\ll{} ";
        case ">>": return " {}\\gg{} ";
        case "\\pm": return " {}\\pm{} ";
        case "\\approx": return " {}\\approx{} ";
        case "$\\approx$": return " {}\\approx{} ";
        case "v": return " \\downarrow{} ";
        case "(v)": return " \\downarrow{} ";
        case "^": return " \\uparrow{} ";
        case "(^)": return " \\uparrow{} ";
        default:
          assertNever(a);
          throw ["MhchemBugT", "mhchem bug T. Please report."];
      }
    }
  };

  //
  // Helpers for code anaylsis
  // Will show type error at calling position
  //
  function assertNever(a: never): void { void a; }
  function assertString(a: string): void { void a; }

export default mhchem
