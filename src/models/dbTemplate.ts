/**
 * Database template metadata record (PostgreSQL template name + label).
 */
export interface DatabaseTemplateModel {
    /**
     * User-facing label for the template.
     */
    name: string;
    /**
     * PostgreSQL database name used as the template source for `createdb -T`.
     */
    templateDbName: string;
    /**
     * Original database this template was cloned from (best-effort metadata).
     */
    sourceDbName?: string;
    /**
     * `<data dir>/filestore` the template's filestore lives under; set when
     * the template was copied, so it is found again whatever version is active.
     */
    filestoreRoot?: string;
    createdAt: string;
    updatedAt?: string;
}
