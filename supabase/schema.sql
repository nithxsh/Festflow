-- ==============================================================================
-- FestFlow: WhatsApp Event Registration & Ticketing Database Schema
-- Compatible with Supabase PostgreSQL
-- ==============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Registrations Table
CREATE TABLE IF NOT EXISTS public.registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    phone_number VARCHAR(32) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    college_name VARCHAR(255) NOT NULL,
    department VARCHAR(120),
    roll_number VARCHAR(64) NOT NULL,
    event_id VARCHAR(64) NOT NULL,
    event_name VARCHAR(255) NOT NULL,
    amount_paid NUMERIC(10, 2) DEFAULT 0.00 NOT NULL,
    utr_number VARCHAR(64) UNIQUE,
    mentor_name VARCHAR(255),
    mentor_phone VARCHAR(32),
    od_status VARCHAR(32) DEFAULT 'PENDING_APPROVAL' CHECK (od_status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'FRAUD_FLAGGED')),
    team_name VARCHAR(255),
    team_members JSONB DEFAULT '[]'::jsonb,
    checked_in BOOLEAN DEFAULT FALSE NOT NULL,
    pass_url TEXT,
    qr_hash TEXT,
    delegate_id VARCHAR(32) UNIQUE,
    fraud_reason TEXT,
    fraud_details JSONB,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Idempotent column additions for existing installations
ALTER TABLE public.registrations ADD COLUMN IF NOT EXISTS team_name VARCHAR(255);
ALTER TABLE public.registrations ADD COLUMN IF NOT EXISTS team_members JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.registrations ADD COLUMN IF NOT EXISTS delegate_id VARCHAR(32) UNIQUE;
ALTER TABLE public.registrations ADD COLUMN IF NOT EXISTS fraud_reason TEXT;
ALTER TABLE public.registrations ADD COLUMN IF NOT EXISTS fraud_details JSONB;

-- Update constraint to allow FRAUD_FLAGGED status
DO $$
BEGIN
    ALTER TABLE public.registrations DROP CONSTRAINT IF EXISTS registrations_od_status_check;
    ALTER TABLE public.registrations ADD CONSTRAINT registrations_od_status_check CHECK (od_status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'FRAUD_FLAGGED'));
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

-- Indexes for ultra-fast lookup during message routing and verification
CREATE INDEX IF NOT EXISTS idx_registrations_utr ON public.registrations (utr_number);
CREATE INDEX IF NOT EXISTS idx_registrations_phone ON public.registrations (phone_number);
CREATE INDEX IF NOT EXISTS idx_registrations_roll ON public.registrations (roll_number);
CREATE INDEX IF NOT EXISTS idx_registrations_delegate_id ON public.registrations (delegate_id);
CREATE INDEX IF NOT EXISTS idx_registrations_event ON public.registrations (event_id);
CREATE INDEX IF NOT EXISTS idx_registrations_mentor_phone ON public.registrations (mentor_phone);
CREATE INDEX IF NOT EXISTS idx_registrations_team_name ON public.registrations (team_name);

-- Automatic updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = TIMEZONE('utc'::text, NOW());
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS trigger_registrations_updated_at ON public.registrations;
CREATE TRIGGER trigger_registrations_updated_at
    BEFORE UPDATE ON public.registrations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
