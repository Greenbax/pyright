/*
 * cacheSerializer.ts
 * Custom serialization/deserialization for Pyright cache
 * Handles complex types like AST nodes, TextRanges, Maps, Sets, etc.
 */

import { TextRange } from './textRange';
import { TextRangeCollection } from './textRangeCollection';
import { ParseNode, ParseNodeType } from '../parser/parseNodes';
import { Diagnostic, DiagnosticCategory } from './diagnostic';

// Type markers for serialization
const TYPE_MARKERS = {
    Map: '__Map__',
    Set: '__Set__',
    TextRange: '__TextRange__',
    TextRangeCollection: '__TextRangeCollection__',
    ParseNode: '__ParseNode__',
    Diagnostic: '__Diagnostic__',
    Date: '__Date__',
    RegExp: '__RegExp__',
    Circular: '__Circular__',
} as const;

interface SerializationContext {
    seen: WeakMap<object, number>;
    refs: any[];
    refCount: number;
}

interface DeserializationContext {
    refs: Map<number, any>;
}

export class CacheSerializer {
    /**
     * Serialize complex objects to JSON-compatible format
     */
    static serialize(data: any): string {
        const context: SerializationContext = {
            seen: new WeakMap(),
            refs: [],
            refCount: 0,
        };

        const serialized = this._serializeValue(data, context);
        
        return JSON.stringify({
            version: 1,
            data: serialized,
            refs: context.refs,
        }, null, 2);
    }

    /**
     * Deserialize from JSON string back to complex objects
     */
    static deserialize(json: string): any {
        try {
            const parsed = JSON.parse(json);
            
            if (!parsed.version || parsed.version !== 1) {
                throw new Error('Unsupported cache version');
            }

            const context: DeserializationContext = {
                refs: new Map(),
            };

            return this._deserializeValue(parsed.data, context, parsed.refs);
        } catch (e) {
            throw new Error(`Failed to deserialize cache: ${e}`);
        }
    }

    private static _serializeValue(value: any, context: SerializationContext): any {
        // Handle primitives
        if (value === null || value === undefined) {
            return value;
        }

        if (typeof value !== 'object' && typeof value !== 'function') {
            return value;
        }

        // Skip functions
        if (typeof value === 'function') {
            return undefined;
        }

        // Handle circular references
        if (context.seen.has(value)) {
            const refId = context.seen.get(value)!;
            return { [TYPE_MARKERS.Circular]: refId };
        }

        // Mark as seen
        const refId = context.refCount++;
        context.seen.set(value, refId);

        // Handle Date
        if (value instanceof Date) {
            return {
                [TYPE_MARKERS.Date]: value.toISOString(),
            };
        }

        // Handle RegExp
        if (value instanceof RegExp) {
            return {
                [TYPE_MARKERS.RegExp]: {
                    source: value.source,
                    flags: value.flags,
                },
            };
        }

        // Handle Map
        if (value instanceof Map) {
            return {
                [TYPE_MARKERS.Map]: Array.from(value.entries()).map(([k, v]) => [
                    this._serializeValue(k, context),
                    this._serializeValue(v, context),
                ]),
            };
        }

        // Handle Set
        if (value instanceof Set) {
            return {
                [TYPE_MARKERS.Set]: Array.from(value).map((v) => this._serializeValue(v, context)),
            };
        }

        // Handle TextRange
        if (this._isTextRange(value)) {
            return {
                [TYPE_MARKERS.TextRange]: {
                    start: value.start,
                    length: value.length,
                },
            };
        }

        // Handle TextRangeCollection
        if (value instanceof TextRangeCollection) {
            // Serialize all items by iterating through them
            const items: any[] = [];
            for (let i = 0; i < value.count; i++) {
                items.push(this._serializeValue(value.getItemAt(i), context));
            }
            return {
                [TYPE_MARKERS.TextRangeCollection]: {
                    items,
                    count: value.count,
                },
            };
        }

        // Handle ParseNode (simplified - store essential properties)
        if (this._isParseNode(value)) {
            return {
                [TYPE_MARKERS.ParseNode]: {
                    nodeType: value.nodeType,
                    id: value.id,
                    start: value.start,
                    length: value.length,
                    // Store only essential properties, not full tree
                    // Full AST reconstruction is complex and may not be worth it
                },
            };
        }

        // Handle Diagnostic
        if (this._isDiagnostic(value)) {
            return {
                [TYPE_MARKERS.Diagnostic]: {
                    category: value.category,
                    message: value.message,
                    range: this._serializeValue(value.range, context),
                    // Skip private properties like rule
                },
            };
        }

        // Handle Arrays
        if (Array.isArray(value)) {
            return value.map((item) => this._serializeValue(item, context));
        }

        // Handle plain objects
        const serialized: any = {};
        for (const key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                try {
                    const serializedValue = this._serializeValue(value[key], context);
                    if (serializedValue !== undefined) {
                        serialized[key] = serializedValue;
                    }
                } catch (e) {
                    // Skip properties that can't be serialized
                }
            }
        }

        return serialized;
    }

    private static _deserializeValue(value: any, context: DeserializationContext, refs: any[]): any {
        // Handle primitives
        if (value === null || value === undefined) {
            return value;
        }

        if (typeof value !== 'object') {
            return value;
        }

        // Handle circular references
        if (value[TYPE_MARKERS.Circular] !== undefined) {
            const refId = value[TYPE_MARKERS.Circular];
            if (context.refs.has(refId)) {
                return context.refs.get(refId);
            }
            // Reference not yet resolved, return placeholder
            return null;
        }

        // Handle Date
        if (value[TYPE_MARKERS.Date] !== undefined) {
            return new Date(value[TYPE_MARKERS.Date]);
        }

        // Handle RegExp
        if (value[TYPE_MARKERS.RegExp] !== undefined) {
            const { source, flags } = value[TYPE_MARKERS.RegExp];
            return new RegExp(source, flags);
        }

        // Handle Map
        if (value[TYPE_MARKERS.Map] !== undefined) {
            const entries = value[TYPE_MARKERS.Map].map(([k, v]: [any, any]) => [
                this._deserializeValue(k, context, refs),
                this._deserializeValue(v, context, refs),
            ]);
            return new Map(entries);
        }

        // Handle Set
        if (value[TYPE_MARKERS.Set] !== undefined) {
            const values = value[TYPE_MARKERS.Set].map((v: any) =>
                this._deserializeValue(v, context, refs)
            );
            return new Set(values);
        }

        // Handle TextRange
        if (value[TYPE_MARKERS.TextRange] !== undefined) {
            const { start, length } = value[TYPE_MARKERS.TextRange];
            return { start, length } as TextRange;
        }

        // Handle TextRangeCollection
        if (value[TYPE_MARKERS.TextRangeCollection] !== undefined) {
            const items = this._deserializeValue(value[TYPE_MARKERS.TextRangeCollection].items, context, refs);
            return new TextRangeCollection(items);
        }

        // Handle ParseNode (simplified restoration)
        if (value[TYPE_MARKERS.ParseNode] !== undefined) {
            const { nodeType, id, start, length } = value[TYPE_MARKERS.ParseNode];
            // Return a minimal parse node object
            // Full AST reconstruction would require more complex logic
            return {
                nodeType,
                id,
                start,
                length,
            };
        }

        // Handle Diagnostic
        if (value[TYPE_MARKERS.Diagnostic] !== undefined) {
            const { category, message, range } = value[TYPE_MARKERS.Diagnostic];
            return {
                category,
                message,
                range: this._deserializeValue(range, context, refs),
            };
        }

        // Handle Arrays
        if (Array.isArray(value)) {
            return value.map((item) => this._deserializeValue(item, context, refs));
        }

        // Handle plain objects
        const deserialized: any = {};
        for (const key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                deserialized[key] = this._deserializeValue(value[key], context, refs);
            }
        }

        return deserialized;
    }

    // Type guards
    private static _isTextRange(value: any): value is TextRange {
        return (
            value &&
            typeof value === 'object' &&
            typeof value.start === 'number' &&
            typeof value.length === 'number'
        );
    }

    private static _isParseNode(value: any): value is ParseNode {
        return (
            value &&
            typeof value === 'object' &&
            'nodeType' in value &&
            'id' in value &&
            typeof value.start === 'number' &&
            typeof value.length === 'number'
        );
    }

    private static _isDiagnostic(value: any): value is Diagnostic {
        return (
            value &&
            typeof value === 'object' &&
            'category' in value &&
            'message' in value &&
            'range' in value
        );
    }
}

/**
 * Simplified serializer for cases where full object reconstruction isn't needed
 * This is faster and more reliable for metadata caching
 */
export class SimpleSerializer {
    static serialize(data: any): string {
        const seen = new WeakSet();
        
        return JSON.stringify(data, (key, value) => {
            if (typeof value === 'object' && value !== null) {
                // Handle circular references
                if (seen.has(value)) {
                    return '[Circular]';
                }
                seen.add(value);
                
                // Skip functions
                if (typeof value === 'function') {
                    return undefined;
                }
                
                // Convert Map to plain object
                if (value instanceof Map) {
                    return {
                        _type: 'Map',
                        entries: Array.from(value.entries()),
                    };
                }
                
                // Convert Set to array
                if (value instanceof Set) {
                    return {
                        _type: 'Set',
                        values: Array.from(value),
                    };
                }
                
                // Convert Date to ISO string
                if (value instanceof Date) {
                    return {
                        _type: 'Date',
                        value: value.toISOString(),
                    };
                }
            }
            
            return value;
        }, 2);
    }

    static deserialize(json: string): any {
        return JSON.parse(json, (key, value) => {
            if (value && typeof value === 'object') {
                // Restore Map
                if (value._type === 'Map' && Array.isArray(value.entries)) {
                    return new Map(value.entries);
                }
                
                // Restore Set
                if (value._type === 'Set' && Array.isArray(value.values)) {
                    return new Set(value.values);
                }
                
                // Restore Date
                if (value._type === 'Date' && typeof value.value === 'string') {
                    return new Date(value.value);
                }
            }
            
            return value;
        });
    }
}
