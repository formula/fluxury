import { EventEmitter } from 'events';

/**
 * Use invariant() to assert state which your program assumes to be true.
 *
 * Provide sprintf-style format (only %s is supported) and arguments
 * to provide information about what broke and what you were
 * expecting.
 *
 * The invariant message will be stripped in production, but the invariant
 * will remain to ensure logic does not differ in production.
 */

var invariant = function(condition, format, a, b, c, d, e, f) {
  if (!condition) {
    var error;
    if (format === undefined) {
      error = new Error(
        'Minified exception occurred; use the non-minified dev environment ' +
        'for the full error message and additional helpful warnings.'
      );
    } else {
      var args = [a, b, c, d, e, f];
      var argIndex = 0;
      error = new Error(
        'Invariant Violation: ' +
        format.replace(/%s/g, function() { return args[argIndex++]; })
      );
    }

    error.framesToPop = 1; // we don't care about invariant's own frame
    throw error;
  }
};

var _lastID = 1;
var _prefix = 'ID_';

/**
 * Dispatcher is used to broadcast payloads to registered callbacks. This is
 * different from generic pub-sub systems in two ways:
 *
 *   1) Callbacks are not subscribed to particular events. Every payload is
 *      dispatched to every registered callback.
 *   2) Callbacks can be deferred in whole or part until other callbacks have
 *      been executed.
 *
 * For example, consider this hypothetical flight destination form, which
 * selects a default city when a country is selected:
 *
 *   var flightDispatcher = new Dispatcher();
 *
 *   // Keeps track of which country is selected
 *   var CountryStore = {country: null};
 *
 *   // Keeps track of which city is selected
 *   var CityStore = {city: null};
 *
 *   // Keeps track of the base flight price of the selected city
 *   var FlightPriceStore = {price: null}
 *
 * When a user changes the selected city, we dispatch the payload:
 *
 *   flightDispatcher.dispatch({
 *     actionType: 'city-update',
 *     selectedCity: 'paris'
 *   });
 *
 * This payload is digested by `CityStore`:
 *
 *   flightDispatcher.register(function(payload) {
 *     if (payload.actionType === 'city-update') {
 *       CityStore.city = payload.selectedCity;
 *     }
 *   });
 *
 * When the user selects a country, we dispatch the payload:
 *
 *   flightDispatcher.dispatch({
 *     actionType: 'country-update',
 *     selectedCountry: 'australia'
 *   });
 *
 * This payload is digested by both stores:
 *
 *    CountryStore.dispatchToken = flightDispatcher.register(function(payload) {
 *     if (payload.actionType === 'country-update') {
 *       CountryStore.country = payload.selectedCountry;
 *     }
 *   });
 *
 * When the callback to update `CountryStore` is registered, we save a reference
 * to the returned token. Using this token with `waitFor()`, we can guarantee
 * that `CountryStore` is updated before the callback that updates `CityStore`
 * needs to query its data.
 *
 *   CityStore.dispatchToken = flightDispatcher.register(function(payload) {
 *     if (payload.actionType === 'country-update') {
 *       // `CountryStore.country` may not be updated.
 *       flightDispatcher.waitFor([CountryStore.dispatchToken]);
 *       // `CountryStore.country` is now guaranteed to be updated.
 *
 *       // Select the default city for the new country
 *       CityStore.city = getDefaultCityForCountry(CountryStore.country);
 *     }
 *   });
 *
 * The usage of `waitFor()` can be chained, for example:
 *
 *   FlightPriceStore.dispatchToken =
 *     flightDispatcher.register(function(payload) {
 *       switch (payload.actionType) {
 *         case 'country-update':
 *           flightDispatcher.waitFor([CityStore.dispatchToken]);
 *           FlightPriceStore.price =
 *             getFlightPriceStore(CountryStore.country, CityStore.city);
 *           break;
 *
 *         case 'city-update':
 *           FlightPriceStore.price =
 *             FlightPriceStore(CountryStore.country, CityStore.city);
 *           break;
 *     }
 *   });
 *
 * The `country-update` payload will be guaranteed to invoke the stores'
 * registered callbacks in order: `CountryStore`, `CityStore`, then
 * `FlightPriceStore`.
 */
class Dispatcher {
  constructor() {
    this._callbacks = {};
    this._isPending = {};
    this._isHandled = {};
    this._isDispatching = false;
    this._pendingPayload = null;
  }

  /**
   * Registers a callback to be invoked with every dispatched payload. Returns
   * a token that can be used with `waitFor()`.
   *
   * @param {function} callback
   * @return {string}
   */
  register(callback) {
    var id = _prefix + _lastID++;
    this._callbacks[id] = callback;
    return id;
  }

  /**
   * Removes a callback based on its token.
   *
   * @param {string} id
   */
  unregister(id) {
    invariant(
      this._callbacks[id],
      'Dispatcher.unregister(...): `%s` does not map to a registered callback.',
      id
    );
    delete this._callbacks[id];
  }

  /**
   * Waits for the callbacks specified to be invoked before continuing execution
   * of the current callback. This method should only be used by a callback in
   * response to a dispatched payload.
   *
   * @param {array<string>} ids
   */
  waitFor(ids) {
    invariant(
      this._isDispatching,
      'Dispatcher.waitFor(...): Must be invoked while dispatching.'
    );
    for (var ii = 0; ii < ids.length; ii++) {
      var id = ids[ii];
      if (this._isPending[id]) {
        invariant(
          this._isHandled[id],
          'Dispatcher.waitFor(...): Circular dependency detected while ' +
          'waiting for `%s`.',
          id
        );
        continue;
      }
      invariant(
        this._callbacks[id],
        'Dispatcher.waitFor(...): `%s` does not map to a registered callback.',
        id
      );
      this._invokeCallback(id);
    }
  }

  /**
   * Dispatches a payload to all registered callbacks.
   *
   * @param {object} payload
   */
  dispatch(payload) {
    invariant(
      !this._isDispatching,
      'Dispatch.dispatch(...): Cannot dispatch in the middle of a dispatch.'
    );
    this._startDispatching(payload);
    try {
      for (var id in this._callbacks) {
        if (this._isPending[id]) {
          continue;
        }
        this._invokeCallback(id);
      }
    } finally {
      this._stopDispatching();
    }
  }

  /**
   * Is this Dispatcher currently dispatching.
   *
   * @return {boolean}
   */
  isDispatching() {
    return this._isDispatching;
  }

  /**
   * Call the callback stored with the given id. Also do some internal
   * bookkeeping.
   *
   * @param {string} id
   * @internal
   */
  _invokeCallback(id) {
    this._isPending[id] = true;
    this._callbacks[id](this._pendingPayload);
    this._isHandled[id] = true;
  }

  /**
   * Set up bookkeeping needed when dispatching.
   *
   * @param {object} payload
   * @internal
   */
  _startDispatching(payload) {
    for (var id in this._callbacks) {
      this._isPending[id] = false;
      this._isHandled[id] = false;
    }
    this._pendingPayload = payload;
    this._isDispatching = true;
  }

  /**
   * Clear bookkeeping used for dispatching.
   *
   * @internal
   */
  _stopDispatching() {
    this._pendingPayload = null;
    this._isDispatching = false;
  }
}

let count = 0;

/*
Object.assign polyfill copied from MDN
https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign#Polyfill
*/
if (!Object.assign) {
  Object.defineProperty(Object, 'assign', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function(target) {
      'use strict';
      if (target === undefined || target === null) {
        throw new TypeError('Cannot convert first argument to object');
      }

      var to = Object(target);
      for (var i = 1; i < arguments.length; i++) {
        var nextSource = arguments[i];
        if (nextSource === undefined || nextSource === null) {
          continue;
        }
        nextSource = Object(nextSource);

        var keysArray = Object.keys(nextSource);
        for (var nextIndex = 0, len = keysArray.length; nextIndex < len; nextIndex++) {
          var nextKey = keysArray[nextIndex];
          var desc = Object.getOwnPropertyDescriptor(nextSource, nextKey);
          if (desc !== undefined && desc.enumerable) {
            to[nextKey] = nextSource[nextKey];
          }
        }
      }
      return to;
    }
  });
}

// This is a sham that makes Object.freeze work (insecurely) in ES3 environments
// ES5 15.2.3.9
// http://es5.github.com/#x15.2.3.9
if (!Object.freeze) {
  Object.freeze = function freeze(object) {
    if (Object(object) !== object) {
      throw new TypeError('Object.freeze can only be called on Objects.');
    }
    // this is misleading and breaks feature-detection, but
    // allows "securable" code to "gracefully" degrade to working
    // but insecure code.
    return object;
  };
}

let dispatcher = new Dispatcher();
let waitFor = dispatcher.waitFor.bind(dispatcher);
function dispatch(type, data) {
  try {

    if (typeof type === 'string') {
      dispatcher.dispatch({ type: type, data: data })
    } else if (typeof type === 'object') {
      dispatcher.dispatch(type)
    } else {
      throw "type must be string or object"
    }

    return Promise.resolve({ type, data })

  } catch(e) {
    return Promise.reject(e)
  }
}

function createStore(reducerOrConfig, selectors={}) {

  let currentState;
  var emitter = new EventEmitter();
  let actions = {};
  let reduce = undefined;
  let noop = () => {}

  if (typeof reducerOrConfig === 'function') {
    currentState = reducerOrConfig(undefined, {}, noop)
    reduce = reducerOrConfig
  } else if (typeof reducerOrConfig === 'object') {

    currentState = typeof reducerOrConfig.getInitialState === 'function' ?
    reducerOrConfig.getInitialState(undefined, {}, noop) : undefined;

    // construct a reduce method with the object
    reduce = ((state, action) => {
      if (action && typeof action.type === 'string' && reducerOrConfig.hasOwnProperty(action.type)) {
        return reducerOrConfig[action.type](state, action.data, waitFor);
      }
      return state;
    })

    // create helpful action methods
    actions = Object.keys(reducerOrConfig)
    .reduce((a, b) => {
      a[b] = (data) => dispatcher.dispatch({
        type: b,
        data: data
      })
      return a;
    }, {})

  } else {
    throw new Error('first argument must be object or function', reducerOrConfig)
  }

  let boundMethods = Object.keys(selectors).reduce(function(a, b, i) {
    var newFunc = {};
    newFunc[b] = function(...params) {
      return selectors[b](currentState, ...params);
    }
    return Object.assign(a, newFunc)
  }, {})

  return Object.freeze(
    Object.assign(
      {},
      boundMethods,
      actions,
      {
        dispatchToken: dispatcher.register( function(action) {
          var newState = reduce(currentState, action, waitFor);
          if (currentState !== newState) {
            currentState = typeof newState === 'object' ? Object.freeze(newState) : newState;
            emitter.emit('changed');
          }
        }),
        subscribe: function(cb) {
          if (typeof cb !== 'function') {
            throw "Callback must be a function";
          }

          emitter.addListener('changed', cb)

          count += 1

          return () => {
            emitter.removeListener('changed', cb)
          }
        },
        reduce: (state, action) => reduce(state, action, waitFor),
        setState: (state) => { currentState = state },
        dispatch: (...action) => dispatch(...action),
        getState: function(cb) {
          return currentState;
        }
      }
    )
  );
}

// Compose
function composeStore(...spec) {

  function isMappedObject(...spec) {
    return (spec.length === 1 &&
      typeof spec[0] === 'object' &&
      typeof spec[0].getState === 'undefined')
  }

  function getState(isMapped, ...spec) {

    if (isMappedObject(...spec)) {
      return Object.keys(spec[0]).reduce((acc, key) => {
        acc[key] = spec[0][key].getState()
        return acc;
      }, {})
    }

    return spec.map(n => n.getState())
  }

  function getStores(isMapped, ...spec) {
    if (isMapped) {
        return Object.keys(spec[0]).reduce((acc, key) => acc.concat(spec[0][key]), [])
    } else {
      spec.forEach( store => {
        if (typeof store.getState !== 'function') {
          if (console && console.log) {
            console.log('ERROR: invalid store')
          }
        }
      })
      return spec
    }
  }

  let isMapped = isMappedObject(...spec)
  let defaultState = getState(isMapped, ...spec)
  let stores = getStores(isMapped, ...spec)

  let dispatchTokens = stores.map(n => n.dispatchToken )

  return createStore(
    (state=defaultState, action, waitFor) => {

      waitFor(dispatchTokens)

      let newState = getState(isMapped, ...spec)

      if (isMapped){ // object specified

        if ( Object.keys(spec[0]).reduce(
          (current, key) =>
          (current && state[key] === newState[key]), true
        )) {
          return state;
        }

      } else { // array specified

        // not changed
        if (
          state.length === newState.length &&
          state.every( (n, i) => n === newState[i] )
        ) {
          return state
        }

      }

      return newState

    },
    {
      getState:(state) => getState(isMapped, ...state)
    }
  )
}

export { dispatch, createStore, composeStore };