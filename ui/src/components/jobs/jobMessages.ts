/** What a modal says when it is pointed at a job this tab has never seen. */
export const JOB_UNKNOWN_TEXT = "This job is no longer running."

/**
 * What a modal says about a job that was running when this tab last heard
 * from it and has since left the store: over plain HTTP a hidden tab gives up
 * its stream, so the end of the job happened out of sight.
 */
export const JOB_GONE_TEXT = "This finished while this tab was away."
