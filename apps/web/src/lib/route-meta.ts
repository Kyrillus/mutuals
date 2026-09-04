/**
 * The breadcrumb lives on the route, not in a table beside it.
 *
 * §5.1 asks for `Contacts › Anna Berger`, which means every crumb has to come from a matched route
 * — including the ones a later stage adds. `staticData` is the router's own slot for that, so a new
 * route declares its crumb where it declares its component and the breadcrumb needs no edit.
 *
 * `crumb` is **optional** on purpose: `UpdatableStaticRouteOption` resolves to a required
 * `staticData` the moment this interface has a required key, which would force every route in the
 * app to carry one.
 */
declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    crumb?: string
  }
}

export {}
