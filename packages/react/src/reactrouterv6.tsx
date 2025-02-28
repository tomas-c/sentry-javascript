// Inspired from Donnie McNeal's solution:
// https://gist.github.com/wontondon/e8c4bdf2888875e4c755712e99279536

import { WINDOW } from '@sentry/browser';
import { Transaction, TransactionContext, TransactionSource } from '@sentry/types';
import { getNumberOfUrlSegments, logger } from '@sentry/utils';
import hoistNonReactStatics from 'hoist-non-react-statics';
import React from 'react';

import { Action, Location } from './types';

interface NonIndexRouteObject {
  caseSensitive?: boolean;
  children?: RouteObject[];
  element?: React.ReactNode | null;
  index?: false;
  path?: string;
}

interface IndexRouteObject {
  caseSensitive?: boolean;
  children?: undefined;
  element?: React.ReactNode | null;
  index?: true;
  path?: string;
}

// This type was originally just `type RouteObject = IndexRouteObject`, but this was changed
// in https://github.com/remix-run/react-router/pull/9366, which was released with `6.4.2`
// See https://github.com/remix-run/react-router/issues/9427 for a discussion on this.
type RouteObject = IndexRouteObject | NonIndexRouteObject;

type Params<Key extends string = string> = {
  readonly [key in Key]: string | undefined;
};

type UseRoutes = (routes: RouteObject[], locationArg?: Partial<Location> | string) => React.ReactElement | null;

// https://github.com/remix-run/react-router/blob/9fa54d643134cd75a0335581a75db8100ed42828/packages/react-router/lib/router.ts#L114-L134
interface RouteMatch<ParamKey extends string = string> {
  /**
   * The names and values of dynamic parameters in the URL.
   */
  params: Params<ParamKey>;
  /**
   * The portion of the URL pathname that was matched.
   */
  pathname: string;
  /**
   * The portion of the URL pathname that was matched before child routes.
   */
  pathnameBase: string;
  /**
   * The route object that was used to match.
   */
  route: RouteObject;
}

type UseEffect = (cb: () => void, deps: unknown[]) => void;
type UseLocation = () => Location;
type UseNavigationType = () => Action;

// For both of these types, use `any` instead of `RouteObject[]` or `RouteMatch[]`.
// Have to do this so we maintain backwards compatability between
// react-router > 6.0.0 and >= 6.4.2.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteObjectArrayAlias = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteMatchAlias = any;
type CreateRoutesFromChildren = (children: JSX.Element[]) => RouteObjectArrayAlias;
type MatchRoutes = (routes: RouteObjectArrayAlias, location: Location) => RouteMatchAlias[] | null;

let activeTransaction: Transaction | undefined;

let _useEffect: UseEffect;
let _useLocation: UseLocation;
let _useNavigationType: UseNavigationType;
let _createRoutesFromChildren: CreateRoutesFromChildren;
let _matchRoutes: MatchRoutes;
let _customStartTransaction: (context: TransactionContext) => Transaction | undefined;
let _startTransactionOnLocationChange: boolean;

const SENTRY_TAGS = {
  'routing.instrumentation': 'react-router-v6',
};

export function reactRouterV6Instrumentation(
  useEffect: UseEffect,
  useLocation: UseLocation,
  useNavigationType: UseNavigationType,
  createRoutesFromChildren: CreateRoutesFromChildren,
  matchRoutes: MatchRoutes,
) {
  return (
    customStartTransaction: (context: TransactionContext) => Transaction | undefined,
    startTransactionOnPageLoad = true,
    startTransactionOnLocationChange = true,
  ): void => {
    const initPathName = WINDOW && WINDOW.location && WINDOW.location.pathname;
    if (startTransactionOnPageLoad && initPathName) {
      activeTransaction = customStartTransaction({
        name: initPathName,
        op: 'pageload',
        tags: SENTRY_TAGS,
        metadata: {
          source: 'url',
        },
      });
    }

    _useEffect = useEffect;
    _useLocation = useLocation;
    _useNavigationType = useNavigationType;
    _matchRoutes = matchRoutes;
    _createRoutesFromChildren = createRoutesFromChildren;

    _customStartTransaction = customStartTransaction;
    _startTransactionOnLocationChange = startTransactionOnLocationChange;
  };
}

function getNormalizedName(
  routes: RouteObject[],
  location: Location,
  matchRoutes: MatchRoutes,
): [string, TransactionSource] {
  if (!routes || routes.length === 0 || !matchRoutes) {
    return [location.pathname, 'url'];
  }

  const branches = matchRoutes(routes, location) as unknown as RouteMatch[];

  let pathBuilder = '';
  if (branches) {
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let x = 0; x < branches.length; x++) {
      const branch = branches[x];
      const route = branch.route;
      if (route) {
        // Early return if index route
        if (route.index) {
          return [branch.pathname, 'route'];
        }

        const path = route.path;
        if (path) {
          const newPath = path[0] === '/' || pathBuilder[pathBuilder.length - 1] === '/' ? path : `/${path}`;
          pathBuilder += newPath;
          if (branch.pathname === location.pathname) {
            if (
              // If the route defined on the element is something like
              // <Route path="/stores/:storeId/products/:productId" element={<div>Product</div>} />
              // We should check against the branch.pathname for the number of / seperators
              getNumberOfUrlSegments(pathBuilder) !== getNumberOfUrlSegments(branch.pathname) &&
              // We should not count wildcard operators in the url segments calculation
              pathBuilder.slice(-2) !== '/*'
            ) {
              return [newPath, 'route'];
            }
            return [pathBuilder, 'route'];
          }
        }
      }
    }
  }

  return [location.pathname, 'url'];
}

function updatePageloadTransaction(location: Location, routes: RouteObject[]): void {
  if (activeTransaction) {
    activeTransaction.setName(...getNormalizedName(routes, location, _matchRoutes));
  }
}

function handleNavigation(
  location: Location,
  routes: RouteObject[],
  navigationType: Action,
  isBaseLocation: boolean,
): void {
  if (isBaseLocation) {
    if (activeTransaction) {
      activeTransaction.finish();
    }

    return;
  }

  if (_startTransactionOnLocationChange && (navigationType === 'PUSH' || navigationType === 'POP')) {
    if (activeTransaction) {
      activeTransaction.finish();
    }

    const [name, source] = getNormalizedName(routes, location, _matchRoutes);
    activeTransaction = _customStartTransaction({
      name,
      op: 'navigation',
      tags: SENTRY_TAGS,
      metadata: {
        source,
      },
    });
  }
}

export function withSentryReactRouterV6Routing<P extends Record<string, any>, R extends React.FC<P>>(Routes: R): R {
  if (
    !_useEffect ||
    !_useLocation ||
    !_useNavigationType ||
    !_createRoutesFromChildren ||
    !_matchRoutes ||
    !_customStartTransaction
  ) {
    __DEBUG_BUILD__ &&
      logger.warn(`reactRouterV6Instrumentation was unable to wrap Routes because of one or more missing parameters.
      useEffect: ${_useEffect}. useLocation: ${_useLocation}. useNavigationType: ${_useNavigationType}.
      createRoutesFromChildren: ${_createRoutesFromChildren}. matchRoutes: ${_matchRoutes}. customStartTransaction: ${_customStartTransaction}.`);

    return Routes;
  }

  let isBaseLocation: boolean = false;
  let routes: RouteObject[];

  const SentryRoutes: React.FC<P> = (props: P) => {
    const location = _useLocation();
    const navigationType = _useNavigationType();

    _useEffect(() => {
      // Performance concern:
      // This is repeated when <Routes /> is rendered.
      routes = _createRoutesFromChildren(props.children) as RouteObject[];
      isBaseLocation = true;

      updatePageloadTransaction(location, routes);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.children]);

    _useEffect(() => {
      handleNavigation(location, routes, navigationType, isBaseLocation);
    }, [props.children, location, navigationType, isBaseLocation]);

    isBaseLocation = false;

    // @ts-ignore Setting more specific React Component typing for `R` generic above
    // will break advanced type inference done by react router params
    return <Routes {...props} />;
  };

  hoistNonReactStatics(SentryRoutes, Routes);

  // @ts-ignore Setting more specific React Component typing for `R` generic above
  // will break advanced type inference done by react router params
  return SentryRoutes;
}

export function wrapUseRoutes(origUseRoutes: UseRoutes): UseRoutes {
  if (!_useEffect || !_useLocation || !_useNavigationType || !_matchRoutes || !_customStartTransaction) {
    __DEBUG_BUILD__ &&
      logger.warn(
        'reactRouterV6Instrumentation was unable to wrap `useRoutes` because of one or more missing parameters.',
      );

    return origUseRoutes;
  }

  let isBaseLocation: boolean = false;

  return (routes: RouteObject[], location?: Partial<Location> | string): React.ReactElement | null => {
    const SentryRoutes: React.FC<unknown> = (props: unknown) => {
      const Routes = origUseRoutes(routes, location);

      const locationArgObject = typeof location === 'string' ? { pathname: location } : location;
      const locationObject = (locationArgObject as Location) || _useLocation();
      const navigationType = _useNavigationType();

      _useEffect(() => {
        isBaseLocation = true;

        updatePageloadTransaction(locationObject, routes);
      }, [props]);

      _useEffect(() => {
        handleNavigation(locationObject, routes, navigationType, isBaseLocation);
      }, [props, locationObject, navigationType, isBaseLocation]);

      isBaseLocation = false;

      return Routes;
    };

    return <SentryRoutes />;
  };
}
