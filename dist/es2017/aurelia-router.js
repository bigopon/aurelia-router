import { RouteRecognizer } from 'aurelia-route-recognizer';
import { Container } from 'aurelia-dependency-injection';
import { getLogger } from 'aurelia-logging';
import { History } from 'aurelia-history';
import { EventAggregator } from 'aurelia-event-aggregator';

/**
* Determines if the provided object is a navigation command.
* A navigation command is anything with a navigate method.
*
* @param obj The object to check.
*/
function isNavigationCommand(obj) {
    return obj && typeof obj.navigate === 'function';
}
/**
* Used during the activation lifecycle to cause a redirect.
*/
class Redirect {
    /**
     * @param url The URL fragment to use as the navigation destination.
     * @param options The navigation options.
     */
    constructor(url, options = {}) {
        this.url = url;
        this.options = Object.assign({ trigger: true, replace: true }, options);
        this.shouldContinueProcessing = false;
    }
    /**
    * Called by the activation system to set the child router.
    *
    * @param router The router.
    */
    setRouter(router) {
        this.router = router;
    }
    /**
    * Called by the navigation pipeline to navigate.
    *
    * @param appRouter The router to be redirected.
    */
    navigate(appRouter) {
        let navigatingRouter = this.options.useAppRouter ? appRouter : (this.router || appRouter);
        navigatingRouter.navigate(this.url, this.options);
    }
}
/**
* Used during the activation lifecycle to cause a redirect to a named route.
*/
// extends Redirect to avoid having to do instanceof check twice
class RedirectToRoute extends Redirect {
    /**
     * @param route The name of the route.
     * @param params The parameters to be sent to the activation method.
     * @param options The options to use for navigation.
     */
    constructor(route, params = {}, options = {}) {
        super('', options);
        this.route = route;
        this.params = params;
    }
    /**
    * Called by the navigation pipeline to navigate.
    *
    * @param appRouter The router to be redirected.
    */
    navigate(appRouter) {
        let navigatingRouter = this.options.useAppRouter ? appRouter : (this.router || appRouter);
        navigatingRouter.navigateToRoute(this.route, this.params, this.options);
    }
}

/**@internal exported for unit testing */
async function resolveViewModel(viewPortInstruction) {
    if ("moduleId" /* moduleId */ in viewPortInstruction) {
        return viewPortInstruction.moduleId;
    }
    if ("viewModel" /* viewModel */ in viewPortInstruction) {
        // to have undefined as context
        let vm = viewPortInstruction.viewModel;
        let $viewModel = await vm();
        if ($viewModel && typeof $viewModel === 'object') {
            $viewModel = $viewModel.default;
        }
        if (typeof $viewModel !== 'function' && $viewModel !== null) {
            throw new Error(`Invalid viewModel specification in ${viewPortInstruction.name || ''} viewport/route config`);
        }
        return $viewModel;
    }
    throw new Error(`moduleId/viewModel not found in ${viewPortInstruction.name || ''} viewport/route config`);
}

/**
* The strategy to use when activating modules during navigation.
*/
const activationStrategy = {
    noChange: 'no-change',
    invokeLifecycle: 'invoke-lifecycle',
    replace: 'replace'
};
class BuildNavigationPlanStep {
    run(navigationInstruction, next) {
        return _buildNavigationPlan(navigationInstruction)
            .then(plan => {
            if (plan instanceof Redirect) {
                return next.cancel(plan);
            }
            navigationInstruction.plan = plan;
            return next();
        })
            .catch(next.cancel);
    }
}
async function _buildNavigationPlan(instruction, forceLifecycleMinimum) {
    let config = instruction.config;
    if ('redirect' in config) {
        const router = instruction.router;
        const newInstruction = await router._createNavigationInstruction(config.redirect);
        const params = {};
        for (let key in newInstruction.params) {
            // If the param on the redirect points to another param, e.g. { route: first/:this, redirect: second/:this }
            let val = newInstruction.params[key];
            if (typeof val === 'string' && val[0] === ':') {
                val = val.slice(1);
                // And if that param is found on the original instruction then use it
                if (val in instruction.params) {
                    params[key] = instruction.params[val];
                }
            }
            else {
                params[key] = newInstruction.params[key];
            }
        }
        let redirectLocation = router.generate(newInstruction.config.name, params, instruction.options);
        if (instruction.queryString) {
            redirectLocation += '?' + instruction.queryString;
        }
        return new Redirect(redirectLocation);
    }
    const prev = instruction.previousInstruction;
    const viewPortPlans = {};
    const defaults = instruction.router.viewPortDefaults;
    if (prev) {
        let hasNewParams = hasDifferentParameterValues(prev, instruction);
        let pending = [];
        for (let viewPortName in prev.viewPortInstructions) {
            const prevViewPortInstruction = prev.viewPortInstructions[viewPortName];
            let nextViewPortConfig = viewPortName in config.viewPorts
                ? config.viewPorts[viewPortName]
                : prevViewPortInstruction;
            if (nextViewPortConfig.moduleId === null && viewPortName in instruction.router.viewPortDefaults) {
                nextViewPortConfig = defaults[viewPortName];
            }
            // Cannot simply do an equality comparison as user may have code like this:
            // { route: 'a', viewModel: () => import('a') }
            // { route: 'b', viewModel: () => import('a') }
            // the two viewModel factories are different, but they are expected to be the same
            // as they points to the same default export from module 'a'
            let prevViewModelTarget = await resolveViewModel(prevViewPortInstruction);
            let nextViewModelTarget = await resolveViewModel(nextViewPortConfig);
            const viewPortPlan = viewPortPlans[viewPortName] = {
                strategy: activationStrategy.noChange,
                name: viewPortName,
                config: nextViewPortConfig,
                prevComponent: prevViewPortInstruction.component,
                prevModuleId: prevViewModelTarget,
                prevViewModel: prevViewModelTarget
            };
            if (prevViewModelTarget !== nextViewModelTarget) {
                viewPortPlan.strategy = activationStrategy.replace;
            }
            else if ('determineActivationStrategy' in prevViewPortInstruction.component.viewModel) {
                viewPortPlan.strategy = prevViewPortInstruction.component.viewModel
                    .determineActivationStrategy(...instruction.lifecycleArgs);
            }
            else if (config.activationStrategy) {
                viewPortPlan.strategy = config.activationStrategy;
            }
            else if (hasNewParams || forceLifecycleMinimum) {
                viewPortPlan.strategy = activationStrategy.invokeLifecycle;
            }
            else {
                viewPortPlan.strategy = activationStrategy.noChange;
            }
            if (viewPortPlan.strategy !== activationStrategy.replace && prevViewPortInstruction.childRouter) {
                const path = instruction.getWildcardPath();
                const task = prevViewPortInstruction
                    .childRouter
                    ._createNavigationInstruction(path, instruction)
                    .then(async (childNavInstruction) => {
                    viewPortPlan.childNavigationInstruction = childNavInstruction;
                    const childPlanOrRedirect = await _buildNavigationPlan(childNavInstruction, viewPortPlan.strategy === activationStrategy.invokeLifecycle);
                    if (childPlanOrRedirect instanceof Redirect) {
                        return Promise.reject(childPlanOrRedirect);
                    }
                    childNavInstruction.plan = childPlanOrRedirect;
                    // for bluebird ?
                    return null;
                });
                pending.push(task);
            }
        }
        await Promise.all(pending);
        return viewPortPlans;
    }
    for (let viewPortName in config.viewPorts) {
        let viewPortConfig = config.viewPorts[viewPortName];
        if (viewPortConfig.moduleId === null && viewPortName in instruction.router.viewPortDefaults) {
            viewPortConfig = defaults[viewPortName];
        }
        viewPortPlans[viewPortName] = {
            name: viewPortName,
            strategy: activationStrategy.replace,
            config: viewPortConfig
        };
    }
    return Promise.resolve(viewPortPlans);
}
/**@internal exported for unit testing */
function hasDifferentParameterValues(prev, next) {
    let prevParams = prev.params;
    let nextParams = next.params;
    let nextWildCardName = next.config.hasChildRouter ? next.getWildCardName() : null;
    for (let key in nextParams) {
        if (key === nextWildCardName) {
            continue;
        }
        if (prevParams[key] !== nextParams[key]) {
            return true;
        }
    }
    for (let key in prevParams) {
        if (key === nextWildCardName) {
            continue;
        }
        if (prevParams[key] !== nextParams[key]) {
            return true;
        }
    }
    if (!next.options.compareQueryParams) {
        return false;
    }
    let prevQueryParams = prev.queryParams;
    let nextQueryParams = next.queryParams;
    for (let key in nextQueryParams) {
        if (prevQueryParams[key] !== nextQueryParams[key]) {
            return true;
        }
    }
    for (let key in prevQueryParams) {
        if (prevQueryParams[key] !== nextQueryParams[key]) {
            return true;
        }
    }
    return false;
}

class CanDeactivatePreviousStep {
    run(navigationInstruction, next) {
        return processDeactivatable(navigationInstruction, 'canDeactivate', next);
    }
}
class CanActivateNextStep {
    run(navigationInstruction, next) {
        return processActivatable(navigationInstruction, 'canActivate', next);
    }
}
class DeactivatePreviousStep {
    run(navigationInstruction, next) {
        return processDeactivatable(navigationInstruction, 'deactivate', next, true);
    }
}
class ActivateNextStep {
    run(navigationInstruction, next) {
        return processActivatable(navigationInstruction, 'activate', next, true);
    }
}
/**
 * Recursively find list of deactivate-able view models
 * and invoke the either 'canDeactivate' or 'deactivate' on each
 */
/*@internal exported for unit testing */
function processDeactivatable(navigationInstruction, callbackName, next, ignoreResult) {
    const plan = navigationInstruction.plan;
    let infos = findDeactivatable(plan, callbackName);
    let i = infos.length; // query from inside out
    function inspect(val) {
        if (ignoreResult || shouldContinue(val)) {
            return iterate();
        }
        return next.cancel(val);
    }
    function iterate() {
        if (i--) {
            try {
                let viewModel = infos[i];
                let result = viewModel[callbackName](navigationInstruction);
                return processPotential(result, inspect, next.cancel);
            }
            catch (error) {
                return next.cancel(error);
            }
        }
        navigationInstruction.router.couldDeactivate = true;
        return next();
    }
    return iterate();
}
/**
 * Recursively find and returns a list of deactivate-able view models
 */
/*@internal exported for unit testing */
function findDeactivatable(plan, callbackName, list = []) {
    for (let viewPortName in plan) {
        let viewPortPlan = plan[viewPortName];
        let prevComponent = viewPortPlan.prevComponent;
        if ((viewPortPlan.strategy === activationStrategy.invokeLifecycle || viewPortPlan.strategy === activationStrategy.replace)
            && prevComponent) {
            let viewModel = prevComponent.viewModel;
            if (callbackName in viewModel) {
                list.push(viewModel);
            }
        }
        if (viewPortPlan.strategy === activationStrategy.replace && prevComponent) {
            addPreviousDeactivatable(prevComponent, callbackName, list);
        }
        else if (viewPortPlan.childNavigationInstruction) {
            findDeactivatable(viewPortPlan.childNavigationInstruction.plan, callbackName, list);
        }
    }
    return list;
}
/*@internal exported for unit testing */
function addPreviousDeactivatable(component, callbackName, list) {
    let childRouter = component.childRouter;
    if (childRouter && childRouter.currentInstruction) {
        let viewPortInstructions = childRouter.currentInstruction.viewPortInstructions;
        for (let viewPortName in viewPortInstructions) {
            let viewPortInstruction = viewPortInstructions[viewPortName];
            let prevComponent = viewPortInstruction.component;
            let prevViewModel = prevComponent.viewModel;
            if (callbackName in prevViewModel) {
                list.push(prevViewModel);
            }
            addPreviousDeactivatable(prevComponent, callbackName, list);
        }
    }
}
/*@internal exported for unit testing */
function processActivatable(navigationInstruction, callbackName, next, ignoreResult) {
    let infos = findActivatable(navigationInstruction, callbackName);
    let length = infos.length;
    let i = -1; // query from top down
    function inspect(val, router) {
        if (ignoreResult || shouldContinue(val, router)) {
            return iterate();
        }
        return next.cancel(val);
    }
    function iterate() {
        i++;
        if (i < length) {
            try {
                let current = infos[i];
                let result = current.viewModel[callbackName](...current.lifecycleArgs);
                return processPotential(result, (val) => inspect(val, current.router), next.cancel);
            }
            catch (error) {
                return next.cancel(error);
            }
        }
        return next();
    }
    return iterate();
}
/**
 * Find list of activatable view model and add to list (3rd parameter)
 */
/*@internal exported for unit testing */
function findActivatable(navigationInstruction, callbackName, list = [], router) {
    let plan = navigationInstruction.plan;
    Object
        .keys(plan)
        .forEach((viewPortName) => {
        let viewPortPlan = plan[viewPortName];
        let viewPortInstruction = navigationInstruction.viewPortInstructions[viewPortName];
        let viewModel = viewPortInstruction.component.viewModel;
        if ((viewPortPlan.strategy === activationStrategy.invokeLifecycle
            || viewPortPlan.strategy === activationStrategy.replace)
            && callbackName in viewModel) {
            list.push({
                viewModel,
                lifecycleArgs: viewPortInstruction.lifecycleArgs,
                router
            });
        }
        if (viewPortPlan.childNavigationInstruction) {
            findActivatable(viewPortPlan.childNavigationInstruction, callbackName, list, viewPortInstruction.component.childRouter || router);
        }
    });
    return list;
}
/*@internal exported for unit testing */
function shouldContinue(output, router) {
    if (output instanceof Error) {
        return false;
    }
    if (isNavigationCommand(output)) {
        if (typeof output.setRouter === 'function') {
            output.setRouter(router);
        }
        return !!output.shouldContinueProcessing;
    }
    if (output === undefined) {
        return true;
    }
    return output;
}
/**
 * wraps a subscription, allowing unsubscribe calls even if
 * the first value comes synchronously
 */
/*@internal exported for unit testing */
class SafeSubscription {
    constructor(subscriptionFunc) {
        this._subscribed = true;
        this._subscription = subscriptionFunc(this);
        if (!this._subscribed) {
            this.unsubscribe();
        }
    }
    get subscribed() {
        return this._subscribed;
    }
    unsubscribe() {
        if (this._subscribed && this._subscription) {
            this._subscription.unsubscribe();
        }
        this._subscribed = false;
    }
}
/*@internal exported for unit testing */
function processPotential(obj, resolve, reject) {
    if (obj && typeof obj.then === 'function') {
        return Promise.resolve(obj).then(resolve).catch(reject);
    }
    if (obj && typeof obj.subscribe === 'function') {
        let obs = obj;
        return new SafeSubscription(sub => obs.subscribe({
            next() {
                if (sub.subscribed) {
                    sub.unsubscribe();
                    resolve(obj);
                }
            },
            error(error) {
                if (sub.subscribed) {
                    sub.unsubscribe();
                    reject(error);
                }
            },
            complete() {
                if (sub.subscribed) {
                    sub.unsubscribe();
                    resolve(obj);
                }
            }
        }));
    }
    try {
        return resolve(obj);
    }
    catch (error) {
        return reject(error);
    }
}

const moduleIdPropName = 'moduleId';
const viewModelPropName = 'viewModel';
var PropName;
(function (PropName) {
    PropName["viewPorts"] = "viewPorts";
    PropName["moduleId"] = "moduleId";
    PropName["viewModel"] = "viewModel";
    PropName["redirect"] = "redirect";
})(PropName || (PropName = {}));

class CommitChangesStep {
    async run(navigationInstruction, next) {
        await navigationInstruction._commitChanges(true);
        navigationInstruction._updateTitle();
        return next();
    }
}
/**
* Class used to represent an instruction during a navigation.
*/
class NavigationInstruction {
    constructor(init) {
        /**
        * Navigation plans for view ports
        */
        this.plan = null;
        this.options = {};
        Object.assign(this, init);
        this.params = this.params || {};
        this.viewPortInstructions = {};
        let ancestorParams = [];
        let current = this;
        do {
            let currentParams = Object.assign({}, current.params);
            if (current.config && current.config.hasChildRouter) {
                // remove the param for the injected child route segment
                delete currentParams[current.getWildCardName()];
            }
            ancestorParams.unshift(currentParams);
            current = current.parentInstruction;
        } while (current);
        let allParams = Object.assign({}, this.queryParams, ...ancestorParams);
        this.lifecycleArgs = [allParams, this.config, this];
    }
    /**
    * Gets an array containing this instruction and all child instructions for the current navigation.
    */
    getAllInstructions() {
        let instructions = [this];
        for (let key in this.viewPortInstructions) {
            let childInstruction = this.viewPortInstructions[key].childNavigationInstruction;
            if (childInstruction) {
                instructions.push(...childInstruction.getAllInstructions());
            }
        }
        return instructions;
    }
    /**
    * Gets an array containing the instruction and all child instructions for the previous navigation.
    * Previous instructions are no longer available after navigation completes.
    */
    getAllPreviousInstructions() {
        return this.getAllInstructions().map(c => c.previousInstruction).filter(c => c);
    }
    addViewPortInstruction(name, instructionOrStrategy, moduleId, component) {
        let lifecycleArgs = this.lifecycleArgs;
        let config = Object.assign({}, lifecycleArgs[1], { currentViewPort: name });
        let viewportInstruction;
        if (typeof instructionOrStrategy === 'string') {
            viewportInstruction = {
                name: name,
                strategy: instructionOrStrategy,
                moduleId: moduleId,
                component: component,
                childRouter: component.childRouter,
                lifecycleArgs: [lifecycleArgs[0], config, lifecycleArgs[2]]
            };
        }
        else {
            viewportInstruction = {
                name: name,
                strategy: instructionOrStrategy.strategy,
                childRouter: instructionOrStrategy.component.childRouter,
                component: instructionOrStrategy.component,
                lifecycleArgs: [lifecycleArgs[0], config, lifecycleArgs[2]]
            };
            if (moduleIdPropName in instructionOrStrategy) {
                viewportInstruction.moduleId = instructionOrStrategy.moduleId;
            }
            else if (viewModelPropName in instructionOrStrategy) {
                viewportInstruction.viewModel = instructionOrStrategy.viewModel;
            }
            else {
                throw new Error('Invalid instruction. No "moduleId" or "viewModel" found.');
            }
        }
        this.viewPortInstructions[name] = viewportInstruction;
        return viewportInstruction;
    }
    /**
    * Gets the name of the route pattern's wildcard parameter, if applicable.
    */
    getWildCardName() {
        let wildcardIndex = this.config.route.lastIndexOf('*');
        // Todo: make typings have more sense as it is confusing with string/ string[]
        return this.config.route.substr(wildcardIndex + 1);
    }
    /**
    * Gets the path and query string created by filling the route
    * pattern's wildcard parameter with the matching param.
    */
    getWildcardPath() {
        let wildcardName = this.getWildCardName();
        let path = this.params[wildcardName] || '';
        if (this.queryString) {
            path += '?' + this.queryString;
        }
        return path;
    }
    /**
    * Gets the instruction's base URL, accounting for wildcard route parameters.
    */
    getBaseUrl() {
        let fragment = decodeURI(this.fragment);
        if (fragment === '') {
            let nonEmptyRoute = this.router.routes.find(route => {
                return route.name === this.config.name &&
                    route.route !== '';
            });
            if (nonEmptyRoute) {
                fragment = nonEmptyRoute.route;
            }
        }
        if (!this.params) {
            return encodeURI(fragment);
        }
        let wildcardName = this.getWildCardName();
        let path = this.params[wildcardName] || '';
        if (!path) {
            return encodeURI(fragment);
        }
        return encodeURI(fragment.substr(0, fragment.lastIndexOf(path)));
    }
    /**@internal */
    async _commitChanges(waitToSwap) {
        let router = this.router;
        router.currentInstruction = this;
        if (this.previousInstruction) {
            this.previousInstruction.config.navModel.isActive = false;
        }
        this.config.navModel.isActive = true;
        router.refreshNavigation();
        let loads = [];
        let delaySwaps = [];
        for (let viewPortName in this.viewPortInstructions) {
            let viewPortInstruction = this.viewPortInstructions[viewPortName];
            let viewPort = router.viewPorts[viewPortName];
            if (!viewPort) {
                throw new Error(`There was no router-view found in the view for ${viewPortInstruction.moduleId}.`);
            }
            if (viewPortInstruction.strategy === activationStrategy.replace) {
                if (viewPortInstruction.childNavigationInstruction && viewPortInstruction.childNavigationInstruction.parentCatchHandler) {
                    loads.push(viewPortInstruction.childNavigationInstruction._commitChanges(waitToSwap));
                }
                else {
                    if (waitToSwap) {
                        delaySwaps.push({ viewPort, viewPortInstruction });
                    }
                    loads.push(viewPort
                        .process(viewPortInstruction, waitToSwap)
                        .then(() => {
                        if (viewPortInstruction.childNavigationInstruction) {
                            return viewPortInstruction.childNavigationInstruction._commitChanges(waitToSwap);
                        }
                        return Promise.resolve();
                    }));
                }
            }
            else {
                if (viewPortInstruction.childNavigationInstruction) {
                    loads.push(viewPortInstruction.childNavigationInstruction._commitChanges(waitToSwap));
                }
            }
        }
        await Promise.all(loads);
        delaySwaps.forEach(x => x.viewPort.swap(x.viewPortInstruction));
        await Promise.resolve();
        prune(this);
    }
    /**@internal */
    _updateTitle() {
        let title = this._buildTitle(this.router.titleSeparator);
        if (title) {
            this.router.history.setTitle(title);
        }
    }
    /**@internal */
    _buildTitle(separator = ' | ') {
        let title = '';
        let childTitles = [];
        if (this.config.navModel.title) {
            title = this.router.transformTitle(this.config.navModel.title);
        }
        for (let viewPortName in this.viewPortInstructions) {
            let viewPortInstruction = this.viewPortInstructions[viewPortName];
            if (viewPortInstruction.childNavigationInstruction) {
                let childTitle = viewPortInstruction.childNavigationInstruction._buildTitle(separator);
                if (childTitle) {
                    childTitles.push(childTitle);
                }
            }
        }
        if (childTitles.length) {
            title = childTitles.join(separator) + (title ? separator : '') + title;
        }
        if (this.router.title) {
            title += (title ? separator : '') + this.router.transformTitle(this.router.title);
        }
        return title;
    }
}
function prune(instruction) {
    instruction.previousInstruction = null;
    instruction.plan = null;
}

/**
* Class for storing and interacting with a route's navigation settings.
*/
class NavModel {
    constructor(router, relativeHref) {
        /**
        * True if this nav item is currently active.
        */
        this.isActive = false;
        /**
        * The title.
        */
        this.title = null;
        /**
        * This nav item's absolute href.
        */
        this.href = null;
        /**
        * This nav item's relative href.
        */
        this.relativeHref = null;
        /**
        * Data attached to the route at configuration time.
        */
        this.settings = {};
        /**
        * The route config.
        */
        this.config = null;
        this.router = router;
        this.relativeHref = relativeHref;
    }
    /**
    * Sets the route's title and updates document.title.
    *  If the a navigation is in progress, the change will be applied
    *  to document.title when the navigation completes.
    *
    * @param title The new title.
    */
    setTitle(title) {
        this.title = title;
        if (this.isActive) {
            this.router.updateTitle();
        }
    }
}

function _normalizeAbsolutePath(path, hasPushState, absolute = false) {
    if (!hasPushState && path[0] !== '#') {
        path = '#' + path;
    }
    if (hasPushState && absolute) {
        path = path.substring(1, path.length);
    }
    return path;
}
function _createRootedPath(fragment, baseUrl, hasPushState, absolute) {
    if (isAbsoluteUrl.test(fragment)) {
        return fragment;
    }
    let path = '';
    if (baseUrl.length && baseUrl[0] !== '/') {
        path += '/';
    }
    path += baseUrl;
    if ((!path.length || path[path.length - 1] !== '/') && fragment[0] !== '/') {
        path += '/';
    }
    if (path.length && path[path.length - 1] === '/' && fragment[0] === '/') {
        path = path.substring(0, path.length - 1);
    }
    return _normalizeAbsolutePath(path + fragment, hasPushState, absolute);
}
function _resolveUrl(fragment, baseUrl, hasPushState) {
    if (isRootedPath.test(fragment)) {
        return _normalizeAbsolutePath(fragment, hasPushState);
    }
    return _createRootedPath(fragment, baseUrl, hasPushState);
}
function _ensureArrayWithSingleRoutePerConfig(config) {
    let routeConfigs = [];
    if (Array.isArray(config.route)) {
        for (let i = 0, ii = config.route.length; i < ii; ++i) {
            let current = Object.assign({}, config);
            current.route = config.route[i];
            routeConfigs.push(current);
        }
    }
    else {
        routeConfigs.push(Object.assign({}, config));
    }
    return routeConfigs;
}
const isRootedPath = /^#?\//;
const isAbsoluteUrl = /^([a-z][a-z0-9+\-.]*:)?\/\//i;

/**
 * Class used to configure a [[Router]] instance.
 *
 * @constructor
 */
class RouterConfiguration {
    constructor() {
        this.instructions = [];
        this.options = {};
        this.pipelineSteps = [];
    }
    /**
    * Adds a step to be run during the [[Router]]'s navigation pipeline.
    *
    * @param name The name of the pipeline slot to insert the step into.
    * @param step The pipeline step.
    * @chainable
    */
    addPipelineStep(name, step) {
        if (step === null || step === undefined) {
            throw new Error('Pipeline step cannot be null or undefined.');
        }
        this.pipelineSteps.push({ name, step });
        return this;
    }
    /**
    * Adds a step to be run during the [[Router]]'s authorize pipeline slot.
    *
    * @param step The pipeline step.
    * @chainable
    */
    addAuthorizeStep(step) {
        return this.addPipelineStep('authorize', step);
    }
    /**
    * Adds a step to be run during the [[Router]]'s preActivate pipeline slot.
    *
    * @param step The pipeline step.
    * @chainable
    */
    addPreActivateStep(step) {
        return this.addPipelineStep('preActivate', step);
    }
    /**
    * Adds a step to be run during the [[Router]]'s preRender pipeline slot.
    *
    * @param step The pipeline step.
    * @chainable
    */
    addPreRenderStep(step) {
        return this.addPipelineStep('preRender', step);
    }
    /**
    * Adds a step to be run during the [[Router]]'s postRender pipeline slot.
    *
    * @param step The pipeline step.
    * @chainable
    */
    addPostRenderStep(step) {
        return this.addPipelineStep('postRender', step);
    }
    /**
    * Configures a route that will be used if there is no previous location available on navigation cancellation.
    *
    * @param fragment The URL fragment to use as the navigation destination.
    * @chainable
    */
    fallbackRoute(fragment) {
        this._fallbackRoute = fragment;
        return this;
    }
    /**
    * Maps one or more routes to be registered with the router.
    *
    * @param route The [[RouteConfig]] to map, or an array of [[RouteConfig]] to map.
    * @chainable
    */
    map(route) {
        if (Array.isArray(route)) {
            route.forEach(this.map.bind(this));
            return this;
        }
        return this.mapRoute(route);
    }
    /**
     * Configures defaults to use for any view ports.
     *
     * @param viewPortConfig a view port configuration object to use as a
     *  default, of the form { viewPortName: { moduleId } }.
     * @chainable
     */
    useViewPortDefaults(viewPortConfig) {
        this.viewPortDefaults = viewPortConfig;
        return this;
    }
    /**
    * Maps a single route to be registered with the router.
    *
    * @param route The [[RouteConfig]] to map.
    * @chainable
    */
    mapRoute(config) {
        this.instructions.push(router => {
            let routeConfigs = _ensureArrayWithSingleRoutePerConfig(config);
            let navModel;
            for (let i = 0, ii = routeConfigs.length; i < ii; ++i) {
                let routeConfig = routeConfigs[i];
                routeConfig.settings = routeConfig.settings || {};
                if (!navModel) {
                    navModel = router.createNavModel(routeConfig);
                }
                router.addRoute(routeConfig, navModel);
            }
        });
        return this;
    }
    /**
    * Registers an unknown route handler to be run when the URL fragment doesn't match any registered routes.
    *
    * @param config A string containing a moduleId to load, or a [[RouteConfig]], or a function that takes the
    *  [[NavigationInstruction]] and selects a moduleId to load.
    * @chainable
    */
    mapUnknownRoutes(config) {
        this.unknownRouteConfig = config;
        return this;
    }
    /**
    * Applies the current configuration to the specified [[Router]].
    *
    * @param router The [[Router]] to apply the configuration to.
    */
    exportToRouter(router) {
        let instructions = this.instructions;
        for (let i = 0, ii = instructions.length; i < ii; ++i) {
            instructions[i](router);
        }
        if (this.title) {
            router.title = this.title;
        }
        if (this.titleSeparator) {
            router.titleSeparator = this.titleSeparator;
        }
        if (this.unknownRouteConfig) {
            router.handleUnknownRoutes(this.unknownRouteConfig);
        }
        if (this._fallbackRoute) {
            router.fallbackRoute = this._fallbackRoute;
        }
        if (this.viewPortDefaults) {
            router.useViewPortDefaults(this.viewPortDefaults);
        }
        Object.assign(router.options, this.options);
        let pipelineSteps = this.pipelineSteps;
        if (pipelineSteps.length) {
            if (!router.isRoot) {
                throw new Error('Pipeline steps can only be added to the root router');
            }
            let pipelineProvider = router.pipelineProvider;
            for (let i = 0, ii = pipelineSteps.length; i < ii; ++i) {
                let { name, step } = pipelineSteps[i];
                pipelineProvider.addStep(name, step);
            }
        }
    }
}

/**
* The primary class responsible for handling routing and navigation.
*
* @class Router
* @constructor
*/
class Router {
    /**
    * @param container The [[Container]] to use when child routers.
    * @param history The [[History]] implementation to delegate navigation requests to.
    */
    constructor(container, history) {
        /**
        * The parent router, or null if this instance is not a child router.
        */
        this.parent = null;
        this.options = {};
        /**
        * The defaults used when a viewport lacks specified content
        */
        this.viewPortDefaults = {};
        /**
        * Extension point to transform the document title before it is built and displayed.
        * By default, child routers delegate to the parent router, and the app router
        * returns the title unchanged.
        */
        this.transformTitle = (title) => {
            if (this.parent) {
                return this.parent.transformTitle(title);
            }
            return title;
        };
        this.container = container;
        this.history = history;
        this.reset();
    }
    /**
    * Fully resets the router's internal state. Primarily used internally by the framework when multiple calls to setRoot are made.
    * Use with caution (actually, avoid using this). Do not use this to simply change your navigation model.
    */
    reset() {
        this.viewPorts = {};
        this.routes = [];
        this.baseUrl = '';
        this.isConfigured = false;
        this.isNavigating = false;
        this.isExplicitNavigation = false;
        this.isExplicitNavigationBack = false;
        this.isNavigatingFirst = false;
        this.isNavigatingNew = false;
        this.isNavigatingRefresh = false;
        this.isNavigatingForward = false;
        this.isNavigatingBack = false;
        this.couldDeactivate = false;
        this.navigation = [];
        this.currentInstruction = null;
        this.viewPortDefaults = {};
        this._fallbackOrder = 100;
        this._recognizer = new RouteRecognizer();
        this._childRecognizer = new RouteRecognizer();
        this._configuredPromise = new Promise(resolve => {
            this._resolveConfiguredPromise = resolve;
        });
    }
    /**
    * Gets a value indicating whether or not this [[Router]] is the root in the router tree. I.e., it has no parent.
    */
    get isRoot() {
        return !this.parent;
    }
    /**
    * Registers a viewPort to be used as a rendering target for activated routes.
    *
    * @param viewPort The viewPort.
    * @param name The name of the viewPort. 'default' if unspecified.
    */
    registerViewPort(viewPort, name) {
        name = name || 'default';
        this.viewPorts[name] = viewPort;
    }
    /**
    * Returns a Promise that resolves when the router is configured.
    */
    ensureConfigured() {
        return this._configuredPromise;
    }
    /**
    * Configures the router.
    *
    * @param callbackOrConfig The [[RouterConfiguration]] or a callback that takes a [[RouterConfiguration]].
    */
    configure(callbackOrConfig) {
        this.isConfigured = true;
        let result = callbackOrConfig;
        let config;
        if (typeof callbackOrConfig === 'function') {
            config = new RouterConfiguration();
            result = callbackOrConfig(config);
        }
        return Promise
            .resolve(result)
            .then((c) => {
            if (c && c.exportToRouter) {
                config = c;
            }
            config.exportToRouter(this);
            this.isConfigured = true;
            this._resolveConfiguredPromise();
        });
    }
    /**
    * Navigates to a new location.
    *
    * @param fragment The URL fragment to use as the navigation destination.
    * @param options The navigation options.
    */
    navigate(fragment, options) {
        if (!this.isConfigured && this.parent) {
            return this.parent.navigate(fragment, options);
        }
        this.isExplicitNavigation = true;
        return this.history.navigate(_resolveUrl(fragment, this.baseUrl, this.history._hasPushState), options);
    }
    /**
    * Navigates to a new location corresponding to the route and params specified. Equivallent to [[Router.generate]] followed
    * by [[Router.navigate]].
    *
    * @param route The name of the route to use when generating the navigation location.
    * @param params The route parameters to be used when populating the route pattern.
    * @param options The navigation options.
    */
    navigateToRoute(route, params, options) {
        let path = this.generate(route, params);
        return this.navigate(path, options);
    }
    /**
    * Navigates back to the most recent location in history.
    */
    navigateBack() {
        this.isExplicitNavigationBack = true;
        this.history.navigateBack();
    }
    /**
     * Creates a child router of the current router.
     *
     * @param container The [[Container]] to provide to the child router. Uses the current [[Router]]'s [[Container]] if unspecified.
     * @returns {Router} The new child Router.
     */
    createChild(container) {
        let childRouter = new Router(container || this.container.createChild(), this.history);
        childRouter.parent = this;
        return childRouter;
    }
    /**
    * Generates a URL fragment matching the specified route pattern.
    *
    * @param name The name of the route whose pattern should be used to generate the fragment.
    * @param params The route params to be used to populate the route pattern.
    * @param options If options.absolute = true, then absolute url will be generated; otherwise, it will be relative url.
    * @returns {string} A string containing the generated URL fragment.
    */
    generate(name, params, options = {}) {
        let hasRoute = this._recognizer.hasRoute(name);
        if ((!this.isConfigured || !hasRoute) && this.parent) {
            return this.parent.generate(name, params, options);
        }
        if (!hasRoute) {
            throw new Error(`A route with name '${name}' could not be found. Check that \`name: '${name}'\` was specified in the route's config.`);
        }
        let path = this._recognizer.generate(name, params);
        let rootedPath = _createRootedPath(path, this.baseUrl, this.history._hasPushState, options.absolute);
        return options.absolute ? `${this.history.getAbsoluteRoot()}${rootedPath}` : rootedPath;
    }
    /**
    * Creates a [[NavModel]] for the specified route config.
    *
    * @param config The route config.
    */
    createNavModel(config) {
        let navModel = new NavModel(this, 'href' in config
            ? config.href
            // potential error when config.route is a string[] ?
            : config.route);
        navModel.title = config.title;
        navModel.order = config.nav;
        navModel.href = config.href;
        navModel.settings = config.settings;
        navModel.config = config;
        return navModel;
    }
    /**
    * Registers a new route with the router.
    *
    * @param config The [[RouteConfig]].
    * @param navModel The [[NavModel]] to use for the route. May be omitted for single-pattern routes.
    */
    addRoute(config, navModel) {
        if (Array.isArray(config.route)) {
            let routeConfigs = _ensureArrayWithSingleRoutePerConfig(config);
            routeConfigs.forEach(cfg => this.addRoute(cfg, navModel));
            return;
        }
        validateRouteConfig(config, this.routes);
        if (!('viewPorts' in config) && !config.navigationStrategy) {
            let defaultViewPortConfig = {
                view: config.view
            };
            if ("moduleId" /* moduleId */ in config) {
                defaultViewPortConfig["moduleId" /* moduleId */] = config["moduleId" /* moduleId */];
            }
            else {
                defaultViewPortConfig["viewModel" /* viewModel */] = config["viewModel" /* viewModel */];
            }
            config.viewPorts = {
                'default': defaultViewPortConfig
            };
        }
        if (!navModel) {
            navModel = this.createNavModel(config);
        }
        this.routes.push(config);
        let path = config.route;
        if (path.charAt(0) === '/') {
            path = path.substr(1);
        }
        let caseSensitive = config.caseSensitive === true;
        let state = this._recognizer.add({
            path: path,
            handler: config,
            caseSensitive: caseSensitive
        });
        if (path) {
            let settings = config.settings;
            delete config.settings;
            let withChild = JSON.parse(JSON.stringify(config));
            config.settings = settings;
            withChild.route = `${path}/*childRoute`;
            withChild.hasChildRouter = true;
            this._childRecognizer.add({
                path: withChild.route,
                handler: withChild,
                caseSensitive: caseSensitive
            });
            withChild.navModel = navModel;
            withChild.settings = config.settings;
            withChild.navigationStrategy = config.navigationStrategy;
        }
        config.navModel = navModel;
        if ((navModel.order || navModel.order === 0) && this.navigation.indexOf(navModel) === -1) {
            if ((!navModel.href && navModel.href !== '') && (state.types.dynamics || state.types.stars)) {
                throw new Error('Invalid route config for "' + config.route + '" : dynamic routes must specify an "href:" to be included in the navigation model.');
            }
            if (typeof navModel.order !== 'number') {
                navModel.order = ++this._fallbackOrder;
            }
            this.navigation.push(navModel);
            // this is a potential error / inconsistency between browsers
            this.navigation = this.navigation.sort((a, b) => a.order - b.order);
        }
    }
    /**
    * Gets a value indicating whether or not this [[Router]] or one of its ancestors has a route registered with the specified name.
    *
    * @param name The name of the route to check.
    */
    hasRoute(name) {
        return !!(this._recognizer.hasRoute(name) || this.parent && this.parent.hasRoute(name));
    }
    /**
    * Gets a value indicating whether or not this [[Router]] has a route registered with the specified name.
    *
    * @param name The name of the route to check.
    */
    hasOwnRoute(name) {
        return this._recognizer.hasRoute(name);
    }
    /**
    * Register a handler to use when the incoming URL fragment doesn't match any registered routes.
    *
    * @param config The moduleId, or a function that selects the moduleId, or a [[RouteConfig]].
    */
    handleUnknownRoutes(config) {
        if (!config) {
            throw new Error('Invalid unknown route handler');
        }
        this.catchAllHandler = instruction => {
            return this
                ._createRouteConfig(config, instruction)
                .then(c => {
                instruction.config = c;
                return instruction;
            });
        };
    }
    /**
    * Updates the document title using the current navigation instruction.
    */
    updateTitle() {
        if (this.parent) {
            return this.parent.updateTitle();
        }
        if (this.currentInstruction) {
            this.currentInstruction._updateTitle();
        }
        return undefined;
    }
    /**
    * Updates the navigation routes with hrefs relative to the current location.
    * Note: This method will likely move to a plugin in a future release.
    */
    refreshNavigation() {
        let nav = this.navigation;
        for (let i = 0, length = nav.length; i < length; i++) {
            let current = nav[i];
            if (!current.config.href) {
                current.href = _createRootedPath(current.relativeHref, this.baseUrl, this.history._hasPushState);
            }
            else {
                current.href = _normalizeAbsolutePath(current.config.href, this.history._hasPushState);
            }
        }
    }
    /**
     * Sets the default configuration for the view ports. This specifies how to
     *  populate a view port for which no module is specified. The default is
     *  an empty view/view-model pair.
     */
    useViewPortDefaults(viewPortDefaults) {
        for (let viewPortName in viewPortDefaults) {
            let viewPortConfig = viewPortDefaults[viewPortName];
            this.viewPortDefaults[viewPortName] = {
                moduleId: viewPortConfig.moduleId
            };
        }
    }
    /**@internal */
    _refreshBaseUrl() {
        if (this.parent) {
            this.baseUrl = generateBaseUrl(this.parent, this.parent.currentInstruction);
        }
    }
    /**@internal */
    _createNavigationInstruction(url = '', parentInstruction = null) {
        let fragment = url;
        let queryString = '';
        let queryIndex = url.indexOf('?');
        if (queryIndex !== -1) {
            fragment = url.substr(0, queryIndex);
            queryString = url.substr(queryIndex + 1);
        }
        let urlRecognizationResults = this._recognizer.recognize(url);
        if (!urlRecognizationResults || !urlRecognizationResults.length) {
            urlRecognizationResults = this._childRecognizer.recognize(url);
        }
        let instructionInit = {
            fragment,
            queryString,
            config: null,
            parentInstruction,
            previousInstruction: this.currentInstruction,
            router: this,
            options: {
                compareQueryParams: this.options.compareQueryParams
            }
        };
        let result;
        if (urlRecognizationResults && urlRecognizationResults.length) {
            let first = urlRecognizationResults[0];
            let instruction = new NavigationInstruction(Object.assign({}, instructionInit, {
                params: first.params,
                queryParams: first.queryParams || urlRecognizationResults.queryParams,
                config: first.config || first.handler
            }));
            if (typeof first.handler === 'function') {
                result = evaluateNavigationStrategy(instruction, first.handler, first);
            }
            else if (first.handler && typeof first.handler.navigationStrategy === 'function') {
                result = evaluateNavigationStrategy(instruction, first.handler.navigationStrategy, first.handler);
            }
            else {
                result = Promise.resolve(instruction);
            }
        }
        else if (this.catchAllHandler) {
            let instruction = new NavigationInstruction(Object.assign({}, instructionInit, {
                params: { path: fragment },
                queryParams: urlRecognizationResults ? urlRecognizationResults.queryParams : {},
                config: null // config will be created by the catchAllHandler
            }));
            result = evaluateNavigationStrategy(instruction, this.catchAllHandler);
        }
        else if (this.parent) {
            let router = this._parentCatchAllHandler(this.parent);
            if (router) {
                let newParentInstruction = this._findParentInstructionFromRouter(router, parentInstruction);
                let instruction = new NavigationInstruction(Object.assign({}, instructionInit, {
                    params: { path: fragment },
                    queryParams: urlRecognizationResults ? urlRecognizationResults.queryParams : {},
                    router: router,
                    parentInstruction: newParentInstruction,
                    parentCatchHandler: true,
                    config: null // config will be created by the chained parent catchAllHandler
                }));
                result = evaluateNavigationStrategy(instruction, router.catchAllHandler);
            }
        }
        if (result && parentInstruction) {
            this.baseUrl = generateBaseUrl(this.parent, parentInstruction);
        }
        return result || Promise.reject(new Error(`Route not found: ${url}`));
    }
    /**@internal */
    _findParentInstructionFromRouter(router, instruction) {
        if (instruction.router === router) {
            instruction.fragment = router.baseUrl; // need to change the fragment in case of a redirect instead of moduleId
            return instruction;
        }
        else if (instruction.parentInstruction) {
            return this._findParentInstructionFromRouter(router, instruction.parentInstruction);
        }
        return undefined;
    }
    /**@internal */
    _parentCatchAllHandler(router) {
        if (router.catchAllHandler) {
            return router;
        }
        else if (router.parent) {
            return this._parentCatchAllHandler(router.parent);
        }
        return false;
    }
    /**
     * @internal
     */
    _createRouteConfig(config, instruction) {
        return Promise.resolve(config)
            .then(c => {
            if (typeof c === 'string') {
                return { moduleId: c };
            }
            else if (typeof c === 'function') {
                return c(instruction);
            }
            return c;
        })
            .then(c => typeof c === 'string' ? { moduleId: c } : c)
            .then(c => {
            c.route = instruction.params.path;
            validateRouteConfig(c, this.routes);
            if (!c.navModel) {
                c.navModel = this.createNavModel(c);
            }
            return c;
        });
    }
}
/* @internal exported for unit testing */
function generateBaseUrl(router, instruction) {
    return `${router.baseUrl || ''}${instruction.getBaseUrl() || ''}`;
}
/* @internal exported for unit testing */
function validateRouteConfig(config, routes) {
    if (typeof config !== 'object') {
        throw new Error('Invalid Route Config');
    }
    if (typeof config.route !== 'string') {
        let name = config.name || '(no name)';
        throw new Error('Invalid Route Config for "' + name + '": You must specify a "route:" pattern.');
    }
    if (!('redirect' in config
        // TODO: does this handle moduleId: null case?
        || config.moduleId
        || config.navigationStrategy
        || config.viewPorts
        || config.viewModel)) {
        // tslint:disable-next-line:max-line-length
        throw new Error(`Invalid Route Config for "${config.route}": You must specify a "moduleId:", "viewModel:", "redirect:", "navigationStrategy:", or "viewPorts:".`);
    }
    if ("moduleId" /* moduleId */ in config && "viewModel" /* viewModel */ in config) {
        throw new Error(`Invalid Route Config for "${config.route}". Both "moduleId" and "viewModel" specified.`);
    }
}
/* @internal exported for unit testing */
function evaluateNavigationStrategy(instruction, evaluator, context) {
    return Promise
        .resolve(evaluator.call(context, instruction))
        .then(() => {
        let routeConfig = instruction.config;
        if (!("viewPorts" /* viewPorts */ in routeConfig)) {
            let defaultViewPortConfig = {};
            if ("moduleId" /* moduleId */ in routeConfig) {
                defaultViewPortConfig["moduleId" /* moduleId */] = routeConfig["moduleId" /* moduleId */];
            }
            else {
                defaultViewPortConfig["viewModel" /* viewModel */] = routeConfig["viewModel" /* viewModel */];
            }
            routeConfig.viewPorts = {
                'default': defaultViewPortConfig
            };
        }
        return instruction;
    });
}

/**
* The status of a Pipeline.
*/
const pipelineStatus = {
    completed: 'completed',
    canceled: 'canceled',
    rejected: 'rejected',
    running: 'running'
};

/**@internal exported for unit testing */
function createNextFn(instruction, steps) {
    let index = -1;
    const next = function () {
        index++;
        if (index < steps.length) {
            let currentStep = steps[index];
            try {
                return currentStep(instruction, next);
            }
            catch (e) {
                return next.reject(e);
            }
        }
        else {
            return next.complete();
        }
    };
    next.complete = createCompletionHandler(next, pipelineStatus.completed);
    next.cancel = createCompletionHandler(next, pipelineStatus.canceled);
    next.reject = createCompletionHandler(next, pipelineStatus.rejected);
    return next;
}
/**@internal exported for unit testing */
function createCompletionHandler(next, status) {
    return (output) => {
        return Promise.resolve({ status, output, completed: status === pipelineStatus.completed });
    };
}

/**
* The class responsible for managing and processing the navigation pipeline.
*/
class Pipeline {
    constructor() {
        /**
        * The pipeline steps. And steps added via addStep will be converted to a function
        * The actualy running functions with correct step contexts of this pipeline
        */
        this.steps = [];
    }
    /**
    * Adds a step to the pipeline.
    *
    * @param step The pipeline step.
    */
    addStep(step) {
        // This situation is a bit unfortunate where there is an implicit conversion of any incoming step to a fn
        let run;
        if (typeof step === 'function') {
            run = step;
        }
        else if (typeof step.getSteps === 'function') {
            // getSteps is to enable support open slots
            // where devs can add multiple steps into the same slot name
            let steps = step.getSteps();
            for (let i = 0, l = steps.length; i < l; i++) {
                this.addStep(steps[i]);
            }
            return this;
        }
        else {
            run = step.run.bind(step);
        }
        this.steps.push(run);
        return this;
    }
    /**
    * Runs the pipeline.
    *
    * @param instruction The navigation instruction to process.
    */
    run(instruction) {
        const nextFn = createNextFn(instruction, this.steps);
        return nextFn();
    }
}

class RouteLoader {
    loadRoute(router, config, navigationInstruction) {
        throw new Error('Route loaders must implement "loadRoute(router, config, navigationInstruction)".');
    }
}
class LoadRouteStep {
    /**@internal */
    static inject() { return [RouteLoader]; }
    constructor(routeLoader) {
        this.routeLoader = routeLoader;
    }
    run(navigationInstruction, next) {
        return loadNewRoute(this.routeLoader, navigationInstruction)
            .then(next)
            .catch(next.cancel);
    }
}
/*@internal*/ function loadNewRoute(routeLoader, navigationInstruction) {
    let toLoad = determineWhatToLoad(navigationInstruction);
    let loadPromises = toLoad.map((loadingPlan) => loadRoute(routeLoader, loadingPlan.navigationInstruction, loadingPlan.viewPortPlan));
    return Promise.all(loadPromises);
}
/**
 * Determine what are needed to be loaded based on navigation instruction's plan
 * All determined loading plans will be added to 2nd parameter array
 * @param navigationInstruction
 * @param toLoad
 */
/*@internal*/ function determineWhatToLoad(navigationInstruction, toLoad = []) {
    let plans = navigationInstruction.plan;
    for (let viewPortName in plans) {
        let viewPortPlan = plans[viewPortName];
        if (viewPortPlan.strategy === activationStrategy.replace) {
            toLoad.push({ viewPortPlan, navigationInstruction });
            if (viewPortPlan.childNavigationInstruction) {
                determineWhatToLoad(viewPortPlan.childNavigationInstruction, toLoad);
            }
        }
        else {
            // let viewPortInstruction = navigationInstruction.addViewPortInstruction(
            //   viewPortName,
            //   viewPortPlan.strategy,
            //   viewPortPlan.prevModuleId,
            //   viewPortPlan.prevComponent);
            let partialInstruction = {
                strategy: viewPortPlan.strategy,
                component: viewPortPlan.prevComponent
            };
            let prevViewModel = viewPortPlan.prevViewModel;
            if (typeof prevViewModel === 'string' || prevViewModel === null) {
                partialInstruction.moduleId = prevViewModel;
            }
            else if (typeof prevViewModel === 'function') {
                partialInstruction.viewModel = () => prevViewModel;
            }
            else {
                throw new Error('Invaid previous view model specification');
            }
            let viewPortInstruction = navigationInstruction.addViewPortInstruction(viewPortName, partialInstruction);
            if (viewPortPlan.childNavigationInstruction) {
                viewPortInstruction.childNavigationInstruction = viewPortPlan.childNavigationInstruction;
                determineWhatToLoad(viewPortPlan.childNavigationInstruction, toLoad);
            }
        }
    }
    return toLoad;
}
/*@internal*/ async function loadRoute(routeLoader, navigationInstruction, viewPortPlan) {
    let config = viewPortPlan.config;
    let component = await loadComponent(routeLoader, navigationInstruction, viewPortPlan.config);
    // let viewPortInstruction = navigationInstruction.addViewPortInstruction(
    //   viewPortPlan.name,
    //   viewPortPlan.strategy,
    //   moduleId,
    //   component);
    // Missing lifecycleArgs property
    let partialInstruction = {
        strategy: viewPortPlan.strategy,
        component
    };
    if (config) {
        if ("moduleId" /* moduleId */ in config) {
            partialInstruction.moduleId = config.moduleId;
        }
        else {
            partialInstruction.viewModel = config.viewModel;
        }
    }
    let viewPortInstruction = navigationInstruction.addViewPortInstruction(viewPortPlan.name, 
    // Missing lifecycleArgs property
    partialInstruction);
    let childRouter = component.childRouter;
    if (childRouter) {
        let path = navigationInstruction.getWildcardPath();
        const childInstruction = await childRouter._createNavigationInstruction(path, navigationInstruction);
        viewPortPlan.childNavigationInstruction = childInstruction;
        const childPlan = await _buildNavigationPlan(childInstruction);
        if (childPlan instanceof Redirect) {
            return Promise.reject(childPlan);
        }
        childInstruction.plan = childPlan;
        viewPortInstruction.childNavigationInstruction = childInstruction;
        return loadNewRoute(routeLoader, childInstruction);
    }
    return undefined;
}
/*@internal*/ async function loadComponent(routeLoader, navigationInstruction, config) {
    let router = navigationInstruction.router;
    let lifecycleArgs = navigationInstruction.lifecycleArgs;
    let component = await routeLoader.loadRoute(router, config, navigationInstruction);
    let { viewModel, childContainer } = component;
    component.router = router;
    component.config = config;
    if ('configureRouter' in viewModel) {
        let childRouter = childContainer.getChildRouter();
        component.childRouter = childRouter;
        await childRouter.configure(c => viewModel.configureRouter(c, childRouter, ...lifecycleArgs));
    }
    return component;
}

/**@internal exported for unit testing */
// Constant enum to reduce amount of code generated
var SlottableStep;
(function (SlottableStep) {
    SlottableStep["authorize"] = "authorize";
    SlottableStep["preActivate"] = "preActivate";
    SlottableStep["preRender"] = "preRender";
    SlottableStep["postRender"] = "postRender";
    // following are deliberately named in such way
    // probably we will want to remove the alias in future
    // as they are not as useful as expected
    SlottableStep["preActivate__or__modelbind"] = "modelbind";
    SlottableStep["preRender__or__precommit"] = "precommit";
    SlottableStep["postRender__or__postcomplete"] = "postcomplete";
})(SlottableStep || (SlottableStep = {}));
/**@internal exported for unit testing */
class PipelineSlot {
    constructor(container, name, alias) {
        this.steps = [];
        this.container = container;
        this.slotName = name;
        this.slotAlias = alias;
    }
    getSteps() {
        return this.steps.map(x => this.container.get(x));
    }
}
/**
* Class responsible for creating the navigation pipeline.
*/
class PipelineProvider {
    static inject() { return [Container]; }
    constructor(container) {
        this.container = container;
        this._buildSteps();
    }
    /**@internal */
    _buildSteps() {
        this.steps = [
            BuildNavigationPlanStep,
            CanDeactivatePreviousStep,
            LoadRouteStep,
            // adding alias with the same name to prevent error where user pass in an undefined in addStep
            this._createPipelineSlot("authorize" /* authorize */, "authorize" /* authorize */),
            CanActivateNextStep,
            this._createPipelineSlot("preActivate" /* preActivate */, "modelbind" /* preActivate__or__modelbind */),
            // NOTE: app state changes start below - point of no return
            DeactivatePreviousStep,
            ActivateNextStep,
            this._createPipelineSlot("preRender" /* preRender */, "precommit" /* preRender__or__precommit */),
            CommitChangesStep,
            this._createPipelineSlot("postRender" /* postRender */, "postcomplete" /* postRender__or__postcomplete */)
        ];
    }
    /**
    * Create the navigation pipeline.
    */
    createPipeline(useCanDeactivateStep = true) {
        let pipeline = new Pipeline();
        this.steps.forEach(step => {
            if (useCanDeactivateStep || step !== CanDeactivatePreviousStep) {
                pipeline.addStep(this.container.get(step));
            }
        });
        return pipeline;
    }
    /**@internal */
    _findStep(name) {
        // A change compared to v1. (typeof x === 'object') Making it safer to find PipelineSlot
        // As it avoids accidental hook when a step constructor has either static property slotName or slotAlias
        return this.steps.find(x => typeof x === 'object' && (x.slotName === name || x.slotAlias === name));
    }
    /**
    * Adds a step into the pipeline at a known slot location.
    */
    addStep(name, step) {
        let found = this._findStep(name);
        if (found) {
            if (!found.steps.includes(step)) { // prevent duplicates
                found.steps.push(step);
            }
        }
        else {
            throw new Error(`Invalid pipeline slot name: ${name}.`);
        }
    }
    /**
     * Removes a step from a slot in the pipeline
     */
    removeStep(name, step) {
        let slot = this._findStep(name);
        if (slot) {
            slot.steps.splice(slot.steps.indexOf(step), 1);
        }
    }
    /**
     * @internal
     * Clears all steps from a slot in the pipeline
     */
    _clearSteps(name) {
        let slot = this._findStep(name);
        if (slot) {
            slot.steps = [];
        }
    }
    /**
     * Resets all pipeline slots
     */
    reset() {
        this._clearSteps("authorize" /* authorize */);
        this._clearSteps("preActivate" /* preActivate */);
        this._clearSteps("preRender" /* preRender */);
        this._clearSteps("postRender" /* postRender */);
    }
    /**@internal */
    _createPipelineSlot(name, alias) {
        return new PipelineSlot(this.container, name, alias);
    }
}

const logger = getLogger('app-router');
/**
* The main application router.
*/
class AppRouter extends Router {
    /**@internal */
    static inject() { return [Container, History, PipelineProvider, EventAggregator]; }
    constructor(container, history, pipelineProvider, events) {
        super(container, history); // Note the super will call reset internally.
        this.pipelineProvider = pipelineProvider;
        this.events = events;
    }
    /**
    * Fully resets the router's internal state. Primarily used internally by the framework when multiple calls to setRoot are made.
    * Use with caution (actually, avoid using this). Do not use this to simply change your navigation model.
    */
    reset() {
        super.reset();
        this.maxInstructionCount = 10;
        if (!this._queue) {
            this._queue = [];
        }
        else {
            this._queue.length = 0;
        }
    }
    /**
    * Loads the specified URL.
    *
    * @param url The URL fragment to load.
    */
    loadUrl(url) {
        return this
            ._createNavigationInstruction(url)
            .then(instruction => this._queueInstruction(instruction))
            .catch(error => {
            logger.error(error);
            restorePreviousLocation(this);
        });
    }
    /**
    * Registers a viewPort to be used as a rendering target for activated routes.
    *
    * @param viewPort The viewPort.
    * @param name The name of the viewPort. 'default' if unspecified.
    */
    async registerViewPort(viewPort, name) {
        super.registerViewPort(viewPort, name);
        if (!this.isActive) {
            const viewModel = this._findViewModel(viewPort);
            if ('configureRouter' in viewModel) {
                if (!this.isConfigured) {
                    const resolveConfiguredPromise = this._resolveConfiguredPromise;
                    // tslint:disable-next-line
                    this._resolveConfiguredPromise = () => { };
                    await this.configure(config => {
                        viewModel.configureRouter(config, this);
                        return config;
                    });
                    this.activate();
                    resolveConfiguredPromise();
                }
            }
            else {
                this.activate();
            }
        }
        else {
            this._dequeueInstruction();
        }
        return Promise.resolve();
    }
    /**
    * Activates the router. This instructs the router to begin listening for history changes and processing instructions.
    *
    * @params options The set of options to activate the router with.
    */
    activate(options) {
        if (this.isActive) {
            return;
        }
        this.isActive = true;
        // route handler property is responsible for handling url change
        // the interface of aurelia-history isn't clear on this perspective
        this.options = Object.assign({ routeHandler: this.loadUrl.bind(this) }, this.options, options);
        this.history.activate(this.options);
        this._dequeueInstruction();
    }
    /**
    * Deactivates the router.
    */
    deactivate() {
        this.isActive = false;
        this.history.deactivate();
    }
    /**@internal */
    _queueInstruction(instruction) {
        return new Promise((resolve) => {
            instruction.resolve = resolve;
            this._queue.unshift(instruction);
            this._dequeueInstruction();
        });
    }
    /**@internal */
    async _dequeueInstruction(instructionCount = 0) {
        // keep the timing for backward compat
        await Promise.resolve();
        if (this.isNavigating && !instructionCount) {
            return undefined;
        }
        let instruction = this._queue.shift();
        this._queue.length = 0;
        if (!instruction) {
            return undefined;
        }
        this.isNavigating = true;
        let navtracker = this.history.getState('NavigationTracker');
        if (!navtracker && !this.currentNavigationTracker) {
            this.isNavigatingFirst = true;
            this.isNavigatingNew = true;
        }
        else if (!navtracker) {
            this.isNavigatingNew = true;
        }
        else if (!this.currentNavigationTracker) {
            this.isNavigatingRefresh = true;
        }
        else if (this.currentNavigationTracker < navtracker) {
            this.isNavigatingForward = true;
        }
        else if (this.currentNavigationTracker > navtracker) {
            this.isNavigatingBack = true;
        }
        if (!navtracker) {
            navtracker = Date.now();
            this.history.setState('NavigationTracker', navtracker);
        }
        this.currentNavigationTracker = navtracker;
        instruction.previousInstruction = this.currentInstruction;
        if (!instructionCount) {
            this.events.publish('router:navigation:processing', { instruction });
        }
        else if (instructionCount === this.maxInstructionCount - 1) {
            logger.error(`${instructionCount + 1} navigation instructions have been attempted without success. Restoring last known good location.`);
            restorePreviousLocation(this);
            return this._dequeueInstruction(instructionCount + 1);
        }
        else if (instructionCount > this.maxInstructionCount) {
            throw new Error('Maximum navigation attempts exceeded. Giving up.');
        }
        let pipeline = this.pipelineProvider.createPipeline(!this.couldDeactivate);
        let result;
        try {
            const $result = await pipeline.run(instruction);
            result = await processResult(instruction, $result, instructionCount, this);
        }
        catch (error) {
            result = { output: error instanceof Error ? error : new Error(error) };
        }
        return resolveInstruction(instruction, result, !!instructionCount, this);
    }
    /**@internal */
    _findViewModel(viewPort) {
        if (this.container.viewModel) {
            return this.container.viewModel;
        }
        if (viewPort.container) {
            let container = viewPort.container;
            while (container) {
                if (container.viewModel) {
                    this.container.viewModel = container.viewModel;
                    return container.viewModel;
                }
                container = container.parent;
            }
        }
        return undefined;
    }
}
async function processResult(instruction, result, instructionCount, router) {
    if (!(result && 'completed' in result && 'output' in result)) {
        result = result || {};
        result.output = new Error(`Expected router pipeline to return a navigation result, but got [${JSON.stringify(result)}] instead.`);
    }
    let finalResult = null;
    let navigationCommandResult = null;
    if (isNavigationCommand(result.output)) {
        navigationCommandResult = result.output.navigate(router);
    }
    else {
        finalResult = result;
        if (!result.completed) {
            if (result.output instanceof Error) {
                logger.error(result.output.toString());
            }
            restorePreviousLocation(router);
        }
    }
    // The navigation returns void
    // is this necessary
    await navigationCommandResult;
    const innerResult = await router._dequeueInstruction(instructionCount + 1);
    return finalResult || innerResult || result;
}
function resolveInstruction(instruction, result, isInnerInstruction, router) {
    instruction.resolve(result);
    let eventArgs = { instruction, result };
    if (!isInnerInstruction) {
        router.isNavigating = false;
        router.isExplicitNavigation = false;
        router.isExplicitNavigationBack = false;
        router.isNavigatingFirst = false;
        router.isNavigatingNew = false;
        router.isNavigatingRefresh = false;
        router.isNavigatingForward = false;
        router.isNavigatingBack = false;
        router.couldDeactivate = false;
        let eventName;
        if (result.output instanceof Error) {
            eventName = 'error';
        }
        else if (!result.completed) {
            eventName = 'canceled';
        }
        else {
            let queryString = instruction.queryString ? ('?' + instruction.queryString) : '';
            router.history.previousLocation = instruction.fragment + queryString;
            eventName = 'success';
        }
        router.events.publish(`router:navigation:${eventName}`, eventArgs);
        router.events.publish('router:navigation:complete', eventArgs);
    }
    else {
        router.events.publish('router:navigation:child:complete', eventArgs);
    }
    return result;
}
function restorePreviousLocation(router) {
    let previousLocation = router.history.previousLocation;
    if (previousLocation) {
        router.navigate(router.history.previousLocation, { trigger: false, replace: true });
    }
    else if (router.fallbackRoute) {
        router.navigate(router.fallbackRoute, { trigger: true, replace: true });
    }
    else {
        logger.error('Router navigation failed, and no previous location or fallbackRoute could be restored.');
    }
}

export { ActivateNextStep, CanActivateNextStep, CanDeactivatePreviousStep, DeactivatePreviousStep, AppRouter, NavModel, Redirect, RedirectToRoute, isNavigationCommand, activationStrategy, BuildNavigationPlanStep, CommitChangesStep, NavigationInstruction, PipelineProvider, Pipeline, pipelineStatus, RouteLoader, LoadRouteStep, RouterConfiguration, Router };
