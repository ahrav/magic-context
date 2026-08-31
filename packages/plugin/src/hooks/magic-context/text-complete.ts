import { stripPersistedAssistantText } from "./tag-content-primitives";

/**
 *
 *
 *
 *
 *
 *
 *
 */

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },

        output: { text: string },
    ): Promise<void> => {
        output.text = stripPersistedAssistantText(output.text);
    };
}
