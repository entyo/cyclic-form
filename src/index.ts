import { VNode, DOMSource, MainDOMSource } from '@cycle/dom';
import { Scope } from '@cycle/dom/lib/es6/isolate';
import { Component, toIsolated } from '@cycle/isolate';
import { Lens } from '@cycle/state';
import { Endo, id } from 'jazz-func/endo';
import { MemoryStream, Stream } from 'xstream';

import {
    Field,
    FieldsFor,
    FormDeclaration,
    FormRenderer,
    IsolatedForm,
    Sinks,
    Sources,
    ValidatorsFor,
    Values,
    ZoomIn,
} from './types';
import sampleCombine from 'xstream/extra/sampleCombine';

// re-exports
export {
    Field,
    FieldsFor,
    FieldDeclaration,
    FormDeclaration,
    FormRenderer,
    Intent,
    IsolatedForm,
    MetaData,
    Sinks,
    SimpleForm,
    Sources,
    Validator,
    ValidatorsFor,
    View,
    ViewInput,
} from './types';

export function isolate<State extends object, Scope extends Lens<State, any> | keyof State>(
    scope: Scope,
): (
    child: Component<Sources<FormDeclaration<ZoomIn<State, Scope>>>, Sinks<FormDeclaration<ZoomIn<State, Scope>>>>,
) => IsolatedForm<State, ZoomIn<State, Scope>> {
    if (typeof scope === 'string') {
        return toIsolated(scope) as any;
    } else {
        return toIsolated({ state: scope }) as any;
    }
}

export namespace Options {
    /**
     * Options for custom submission.
     * - `predicate` is a function which defines what custom keybinds are. By default, 'Ctrl + Enter' and 'Metakey + Enter' are treated as submission keybinds.
     * - `fields` is the set of the form field which accepts custom keybinds.
     */
    export type CustomSubmission<Decl extends FormDeclaration<any>> = Readonly<{
        fields: Set<keyof Decl>;
        predicate(e: KeyboardEvent): boolean;
    }>;

    export type HoverSubmitButton<Decl extends FormDeclaration<any>> = Readonly<{
        submitButtonField: keyof Decl;
        borderField: keyof Decl;
        hoveringClassName: string;
        scrollY$: Stream<number>;
    }>;
}

/**
 * Options to customize form behavior
 * - `customSubmission` enables the form to be submitted by custom keybinds like 'Ctrl + Enter'.
 */
export type Options<Decl extends FormDeclaration<any>> = Readonly<{
    customSubmission: Options.CustomSubmission<Decl>;
    hoverSubmitButton: Options.HoverSubmitButton<Decl>;
}>;

/**
 * Form component constructor
 *
 * @example
 * form(fieldsConstructor(), {
 *   customSubmission: {
 *     // We can submit this form by pressing 'Ctrl + Enter' while editing 'description' fields
 *     fields: new Set(['description']),
 *     predicate: (e: KeyboardEvent) => e.ctrlKey && e.key === 'Enter'
 *   },
 * })
 *
 */
export function form<Decl extends FormDeclaration<any>>(
    fields: FieldsFor<Decl>,
    options: Options<Decl> = {
        customSubmission: { fields: new Set<keyof Decl>(), predicate: defaultPredicate },
        hoverSubmitButton: {
            borderField: '',
            submitButtonField: '',
            hoveringClassName: 'hovering',
            scrollY$: Stream.empty(),
        },
    },
): Component<Sources<Decl>, Sinks<Decl>> {
    return function Form({
        DOM,
        state,
        renderer$,
        untouch$ = Stream.never(),
        validators$ = Stream.of({}).remember(),
    }: Sources<Decl>): Sinks<Decl> {
        let touchedKeys = new Set<keyof Decl>();
        untouch$.addListener({
            next(key) {
                if (key === null) {
                    touchedKeys = new Set();
                } else {
                    touchedKeys.delete(key);
                }
            },
        });

        // isolate DOM source only when supported
        const isolateSource =
            typeof (DOM as MainDOMSource).isolateSource === 'function'
                ? (DOM as MainDOMSource).isolateSource
                : (source: DOMSource, _scope: any) => source;

        const { customSubmission, hoverSubmitButton } = options;
        const { fields: submissionFields } = customSubmission;
        const { submitButtonField, borderField, hoveringClassName, scrollY$ } = hoverSubmitButton;
        const { predicate } = customSubmission;
        const customSubmission$ = Stream.merge(
            ...Array.from(submissionFields).map(key =>
                isolateSource(DOM, key)
                    .events('keydown')
                    .filter(predicate),
            ),
        );

        const borderHeight$ = (isolateSource(DOM, borderField).element() as MemoryStream<Element>)
            .map(elem => {
                const { y, height } = (elem as Element).getBoundingClientRect() as DOMRect;
                return y + height;
            })
            .debug(borderHeight => console.log({ borderHeight }));

        const buttonsRowY$ = (isolateSource(DOM, submitButtonField).element() as MemoryStream<Element>)
            .map(elem => ((elem as Element).getBoundingClientRect() as DOMRect).y)
            .debug(buttonsRowY => console.log({ buttonsRowY }));

        const reachedToBottom$ = scrollY$
            .debug(scrollY => console.log({ scrollY }))
            .compose(sampleCombine(borderHeight$))
            .compose(sampleCombine(buttonsRowY$))
            .map(([[_, borderHeight], buttonsRowY]) => borderHeight - 30 < buttonsRowY)
            .debug(reached => console.log({ reached }));

        Object.keys(fields).forEach((key: keyof Decl) => {
            const isolatedDOMSource = isolateSource(DOM, key);

            Stream.merge(
                isolatedDOMSource.events('change'),
                isolatedDOMSource.events('focus'),
                isolatedDOMSource.events('input'),
            )
                .take(1)
                .addListener({
                    next(_) {
                        touchedKeys.add(key);
                    },
                });
        });

        const combined$: Stream<[Decl, FormRenderer<Decl>, ValidatorsFor<Decl>, boolean]> = Stream.combine(
            state.stream,
            renderer$,
            validators$,
            reachedToBottom$,
        );

        const reducer$s: Stream<Endo<Values<Decl>>>[] = Object.keys(fields).map((key: keyof Decl) => {
            const field: Field<Decl[keyof Decl]> | null | undefined = fields[key];

            if (!field) {
                return Stream.of(id);
            }

            const { intent } = field as Field<any>;
            const domSource = (field as any).shouldNotIsolate ? DOM : isolateSource(DOM, key);
            const endo$ = intent(domSource);

            return endo$.map((endo: Endo<Values<Decl>>) =>
                evolveC<Values<Decl>>({
                    [key]: endo,
                } as any),
            );
        });
        const reducer$: Stream<Endo<Values<Decl>>> = Stream.merge(...reducer$s);

        const vnode$: MemoryStream<VNode> = combined$
            .map(([values, renderer, validators, reached]) => {
                const errors: Record<keyof Decl, string | null> = Object.keys(fields)
                    .map<[keyof Decl, string | null]>((key: keyof Decl) => {
                        const field: Field<Decl[keyof Decl]> | null | undefined = fields[key];
                        const validator: any = validators[key];

                        if (!field || !validator) {
                            return [key, null];
                        }

                        const value = values[key];
                        const error = validator ? validator(value) : null;

                        return [key, error];
                    })
                    .reduce(
                        (acc: Record<keyof Decl, string | null>, [key, error]: [keyof Decl, string | null]) =>
                            Object.assign({}, acc, { [key]: error }),
                        {} as Record<keyof Decl, string | null>,
                    );

                const allValid = Object.values(errors).every(e => e === null);

                const vnodes: Record<keyof Decl, VNode | null> = Object.keys(fields)
                    .map<[keyof Decl, VNode | null]>((key: keyof Decl) => {
                        const field: Field<Decl[keyof Decl]> | null | undefined = fields[key];
                        const value: Decl[keyof Decl] = values[key];

                        if (!field) {
                            return [key, null];
                        }

                        // any because the validation result differs from field to field
                        const error: any = errors[key] || null;

                        const vnode = field.view(
                            {
                                error,
                                touched: touchedKeys.has(key),
                                value,
                            },
                            { valid: allValid },
                        );

                        if (submitButtonField === key && reached) {
                            const { data } = vnode;
                            if (data) {
                                const { class: classRecord } = data;
                                if (classRecord) {
                                    return [
                                        key,
                                        totalIsolateVNode(
                                            {
                                                ...vnode,
                                                data: {
                                                    ...data,
                                                    class: {
                                                        ...classRecord,
                                                        [hoveringClassName]: true,
                                                    },
                                                },
                                            },
                                            (DOM as MainDOMSource).namespace,
                                            key,
                                        ),
                                    ];
                                }
                            }
                        }
                        return [key, totalIsolateVNode(vnode, (DOM as MainDOMSource).namespace, key)];
                    })
                    .reduce(
                        (acc: Record<keyof Decl, VNode | null>, [key, vnode]: [keyof Decl, VNode]) =>
                            Object.assign({}, acc, { [key]: vnode }),
                        {} as Record<keyof Decl, VNode | null>,
                    );

                const vnode = renderer(vnodes);

                return vnode;
            })
            .remember();

        const submission$ = Stream.merge(
            DOM.select('form').events('submit', { preventDefault: true }),
            customSubmission$,
        );
        return {
            DOM: vnode$,
            state: reducer$,
            submission$,
        };
    };
}

// copied from https://github.com/cyclejs/cyclejs/blob/90645d669f360edd792618e42512ea0d90da189a/dom/src/isolate.ts#L24-L46
// couldn't be imported as it is originally used within map() function
function totalIsolateVNode(node: VNode, namespace: Scope[], scope: string) {
    if (!node) {
        return node;
    }
    const scopeObj: Scope = { type: 'total', scope };
    const newNode = {
        ...node,
        data: {
            ...node.data,
            isolate: !node.data || !Array.isArray(node.data.isolate) ? namespace.concat([scopeObj]) : node.data.isolate,
        },
    };
    return {
        ...newNode,
        key: newNode.key !== undefined ? newNode.key : JSON.stringify(newNode.data.isolate),
    };
}

function evolveC<Struct extends object>(
    transformations: Partial<{ [P in keyof Struct]: Endo<Struct[P]> }>,
): Endo<Struct> {
    return function(struct: Struct): Struct {
        const newStruct: any = Object.create(null);

        Object.keys(struct).forEach((key: keyof Struct) => {
            const f = transformations[key];

            if (typeof f === 'undefined') {
                newStruct[key] = struct[key];
            } else {
                newStruct[key] = f(struct[key]);
            }
        });

        return newStruct as Struct;
    };
}

const ctrlEnter = (e: KeyboardEvent) => e.ctrlKey && e.key === 'Enter';
const metaEnter = (e: KeyboardEvent) => e.metaKey && e.key === 'Enter';
const defaultPredicate = (e: KeyboardEvent) => ctrlEnter(e) || metaEnter(e);
