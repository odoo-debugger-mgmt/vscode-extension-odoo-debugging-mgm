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
    createdAt: string;
    updatedAt?: string;
}
