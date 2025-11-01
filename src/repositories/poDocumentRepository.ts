import pool from '../database';

export interface PoDocument {
    id: number;
    phone: string;
    reference_id: string | null;
    code: string;
    file_id: string;
    file_name: string;
    is_signed: boolean;
    signed_at: Date | null;
    doc_status: 'approved' | 'rejected';
    rejected_at: Date | null;
    reject_reason: string | null;
    rejected_by: string | null;
    created_at: Date;
    updated_at: Date;
}

export class PoDocumentRepository {
    async create(phone: string, reference_id: string | null, code: string, file_id: string, file_name: string): Promise<void> {
        const query = 'INSERT INTO po_documents (phone, reference_id, code, file_id, file_name, is_signed, doc_status) VALUES (?, ?, ?, ?, ?, ?, ?)';
        await pool.execute(query, [phone, reference_id, code, file_id, file_name, false, 'approved']);
    }

    async findByCodeAndFileId(code: string, file_id: string): Promise<PoDocument | null> {
        const query = 'SELECT * FROM po_documents WHERE code = ? AND file_id = ?';
        const [rows] = await pool.execute(query, [code, file_id]);
        const documents = rows as PoDocument[];
        return documents.length > 0 ? documents[0] : null;
    }

    async updateSigned(id: number): Promise<void> {
        const query = 'UPDATE po_documents SET is_signed = TRUE, signed_at = NOW(), doc_status = ? WHERE id = ?';
        await pool.execute(query, ['approved', id]);
    }

    async findUnsignedByCodeAndFileId(code: string, file_id: string): Promise<PoDocument | null> {
        const query = 'SELECT * FROM po_documents WHERE code = ? AND file_id = ? AND is_signed = FALSE AND rejected_at IS NULL';
        const [rows] = await pool.execute(query, [code, file_id]);
        const documents = rows as PoDocument[];
        return documents.length > 0 ? documents[0] : null;
    }

    async rejectDocument(id: number, reason: string, rejected_by: string): Promise<void> {
        const query = 'UPDATE po_documents SET doc_status = ?, rejected_at = NOW(), reject_reason = ?, rejected_by = ? WHERE id = ?';
        await pool.execute(query, ['rejected', reason, rejected_by, id]);
    }
}