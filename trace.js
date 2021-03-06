'use strict';

const chain = require('stack-chain');
const asyncHook = require('async_hooks');

// Contains init asyncId of the active scope(s)
// Because we can't know when the root scope ends, a permanent Set is keept
// for the root scope.
const executionScopeInits = new Set();
let executionScopeDepth = 0;
// Contains the call site objects of all active scopes
const traces = new Map();

//
// Mainiputlate stack trace
//
// add lastTrace to the callSite array
chain.filter.attach(function (error, frames) {
  return frames.filter(function (callSite) {
    const name = callSite && callSite.getFileName();
    return (!name || (name !== 'async_hooks.js' && name !== 'internal/async_hooks.js'));
  });
});

chain.extend.attach(function (error, frames) {
  const lastTrace = traces.get(asyncHook.executionAsyncId());
  frames.push.apply(frames, lastTrace);
  return frames;
});

//
// Track handle objects
//
const hooks = asyncHook.createHook({
  init: asyncInit,
  before: asyncBefore,
  after: asyncAfter,
  destroy: asyncDestroy
});
hooks.enable();

function getCallSites(skip) {
  const limit = Error.stackTraceLimit;

  Error.stackTraceLimit = limit + skip;
  const stack = chain.callSite({
    extend: false,
    filter: true,
    slice: skip
  });
  Error.stackTraceLimit = limit;

  return copyFrames(stack);
}

// We must take a copy of the CallSite objects to avoid retaining references to Promises.
// If we retain a Promise reference then asyncDestroy for the Promise won't be called,
// so we'll leak memory.
class CallSiteCopy {
  constructor(callSite) {
    this._functionName = callSite.getFunctionName();
    this._fileName = callSite.getFileName();
    this._lineNumber = callSite.getLineNumber();
    this._columnNumber = callSite.getColumnNumber();
    this._isConstructor = callSite.isConstructor();
    this._isAsync = callSite.isAsync();
    this._isNative = callSite.isNative();
    this._isToplevel = callSite.isToplevel();
    this._typeName = callSite.getTypeName();
    this._methodName = callSite.getMethodName();
    this._scriptNameOrSourceURL = callSite.getScriptNameOrSourceURL();
    this._isEval = callSite.isEval();
    this._evalOrigin = this.getEvalOrigin();
  }

  getFunctionName() {
    return this._functionName;
  }
  getFileName() {
    return this._fileName;
  }
  getLineNumber() {
    return this._lineNumber;
  }
  getColumnNumber() {
    return this._columnNumber;
  }
  isNative() {
    return this._isNative;
  }
  isConstructor() {
    return this._isConstructor;
  }
  isToplevel() {
    return this._isToplevel;
  }
  getTypeName() {
    return this._typeName;
  }
  getMethodName() {
    return this._methodName;
  }
  getScriptNameOrSourceURL() {
    return this._scriptNameOrSourceURL;
  }
  isEval() {
    return this._isEval;
  }
  getEvalOrigin() {
    return this._evalOrigin;
  }

  // copied from https://github.com/evanw/node-source-map-support/blob/d0587453869fa19f35671f32f4e27514123877a7/source-map-support.js#L272
  toString() {
    var fileName;
    var fileLocation = "";
    if (this.isNative()) {
      fileLocation = "native";
    } else {
      fileName = this.getScriptNameOrSourceURL();
      if (!fileName && this.isEval()) {
        fileLocation = this.getEvalOrigin();
        fileLocation += ", ";  // Expecting source position to follow.
      }

      if (fileName) {
        fileLocation += fileName;
      } else {
        // Source code does not originate from a file and is not native, but we
        // can still get the source position inside the source string, e.g. in
        // an eval string.
        fileLocation += "<anonymous>";
      }
      var lineNumber = this.getLineNumber();
      if (lineNumber != null) {
        fileLocation += ":" + lineNumber;
        var columnNumber = this.getColumnNumber();
        if (columnNumber) {
          fileLocation += ":" + columnNumber;
        }
      }
    }

    var line = "";
    var functionName = this.getFunctionName();
    var addSuffix = true;
    var isConstructor = this.isConstructor();
    var isMethodCall = !(this.isToplevel() || isConstructor);
    if (isMethodCall) {
      var typeName = this.getTypeName();
      // Fixes shim to be backward compatable with Node v0 to v4
      if (typeName === "[object Object]") {
        typeName = "null";
      }
      var methodName = this.getMethodName();
      if (functionName) {
        if (typeName && functionName.indexOf(typeName) != 0) {
          line += typeName + ".";
        }
        line += functionName;
        if (methodName && functionName.indexOf("." + methodName) != functionName.length - methodName.length - 1) {
          line += " [as " + methodName + "]";
        }
      } else {
        line += typeName + "." + (methodName || "<anonymous>");
      }
    } else if (isConstructor) {
      line += "new " + (functionName || "<anonymous>");
    } else if (functionName) {
      line += functionName;
    } else {
      line += fileLocation;
      addSuffix = false;
    }
    if (addSuffix) {
      line += " (" + fileLocation + ")";
    }
    return line;
  }
  inspect() {
    return this.toString()
  }
}

function copyFrames(frames) {
  return frames.map((callSite) => new CallSiteCopy(callSite));
}

function equalCallSite(a, b) {
  const aFile = a.getFileName();
  const aLine = a.getLineNumber();
  const aColumn = a.getColumnNumber();

  if (aFile === null || aLine === null || aColumn === null) {
    return false;
  }

  return (aFile === b.getFileName() &&
          aLine === b.getLineNumber() &&
          aColumn === b.getColumnNumber());
}

function asyncInit(asyncId, type, triggerAsyncId, resource) {
  const trace = getCallSites(2);

  // In cases where the trigger is in the same synchronous execution scope
  // as this resource, the stack trace of the trigger will overlap with
  // `trace`, this mostly happens with promises.
  // Example:
  //   p0 = Promise.resolve(1); // will have `root` in stack trace
  //   p1 = p0.then(() => throw new Error('hello')); // will also have `root`
  // The async stack trace should be: root, p0, p1
  //
  // To avoid (n^2) string matching, it is assumed that `Error.stackTraceLimit`
  // hasn't changed. By this assumtion we know the current trace will go beyond
  // the trigger trace, thus the check can be limited to trace[-1].
  if (executionScopeInits.has(triggerAsyncId)) {
    const parentTrace = traces.get(triggerAsyncId);

    let i = parentTrace.length;
    while(i-- && trace.length > 1) {
      if (equalCallSite(parentTrace[i], trace[trace.length - 1])) {
        trace.pop();
      }
    }
  }

  // Add all the callSites from previuse ticks
  if (triggerAsyncId !== 0) {
    trace.push.apply(trace, traces.get(triggerAsyncId));
  }

  // Cut the trace so it don't contain callSites there won't be shown anyway
  // because of Error.stackTraceLimit
  trace.splice(Error.stackTraceLimit);

  // `trace` now contains callSites from this ticks and all the ticks leading
  // up to this event in time
  traces.set(asyncId, trace);

  // add asyncId to the list of all inits in this execution scope
  executionScopeInits.add(asyncId);
}

function asyncBefore(asyncId) {
  if (executionScopeDepth === 0) {
    executionScopeInits.clear();
  }
  executionScopeDepth += 1;
}

function asyncAfter(asyncId) {
  executionScopeDepth -= 1;
}

function asyncDestroy(asyncId) {
  traces.delete(asyncId);
}
