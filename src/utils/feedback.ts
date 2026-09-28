export const FEEDBACK_ISSUES_URL = 'https://github.com/Lilislv/Setsuna/issues';
export type FeedbackDraft = { kind: 'bug' | 'feature'; title: string; description: string; steps: string; expected: string; includeEnvironment: boolean };
export const EMPTY_FEEDBACK: FeedbackDraft = { kind: 'bug', title: '', description: '', steps: '', expected: '', includeEnvironment: true };
export function normalizeFeedbackDraft(value: any): FeedbackDraft {
    const text = (key: string, limit: number) => typeof value?.[key] === 'string' ? value[key].slice(0, limit) : '';
    return { kind: value?.kind === 'feature' ? 'feature' : 'bug', title: text('title', 120), description: text('description', 8000),
        steps: text('steps', 4000), expected: text('expected', 2000), includeEnvironment: value?.includeEnvironment !== false };
}
export function feedbackPlatform(userAgent: string): string {
    if (/Android/i.test(userAgent)) return 'Android';
    if (/Windows/i.test(userAgent)) return 'Windows';
    if (/iPhone|iPad/i.test(userAgent)) return 'iOS';
    if (/Macintosh|Mac OS/i.test(userAgent)) return 'macOS';
    if (/Linux/i.test(userAgent)) return 'Linux';
    return 'Unknown';
}
export function buildFeedback(draft: FeedbackDraft, version: string, platform: string) {
    const sections = [draft.kind === 'bug' ? '## Bug report' : '## Feature request', draft.description.trim()];
    if (draft.kind === 'bug' && draft.steps.trim()) sections.push('## Steps to reproduce', draft.steps.trim());
    if (draft.kind === 'bug' && draft.expected.trim()) sections.push('## Expected behavior', draft.expected.trim());
    if (draft.includeEnvironment) sections.push('## Environment', `Setsuna: ${version}\nOS: ${platform}`);
    const body = sections.join('\n\n');
    const title = `${draft.kind === 'bug' ? '[Bug]' : '[Feature]'} ${draft.title.trim()}`;
    // No labels/assignees: ordinary reporters need no repository write permissions.
    const url = new URL(`${FEEDBACK_ISSUES_URL}/new`);
    url.searchParams.set('title', title);
    url.searchParams.set('body', body);
    const copyRequired = url.href.length > 7500;
    if (copyRequired) url.searchParams.delete('body');
    return { body, title, url: url.href, copyRequired };
}
