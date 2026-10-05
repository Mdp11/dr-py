import { route } from './engine-route';
import { ElementSchema, type Element } from './types';

// NOTE: paged element listing lives in ./model-read.ts (`listElementsPage`).

/** One element, from the replica. */
export function getElement(elementId: string): Promise<Element> {
	return route<unknown>('getElement', { id: elementId }).then((body) => ElementSchema.parse(body));
}
