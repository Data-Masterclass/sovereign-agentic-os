--
-- PostgreSQL database dump
--

\restrict 2h15avFwMmFfrFq3j1ttjAm7YqyYDjd9znZsO1tx8VqMea7HGAzdcdgvEHZ8hN9

-- Dumped from database version 17.10 (Debian 17.10-1.pgdg13+1)
-- Dumped by pg_dump version 17.10 (Debian 17.10-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: polaris_schema; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA polaris_schema;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: entities; Type: TABLE; Schema: polaris_schema; Owner: -
--

CREATE TABLE polaris_schema.entities (
    realm_id text NOT NULL,
    catalog_id bigint NOT NULL,
    id bigint NOT NULL,
    parent_id bigint NOT NULL,
    name text NOT NULL,
    entity_version integer NOT NULL,
    type_code integer NOT NULL,
    sub_type_code integer NOT NULL,
    create_timestamp bigint NOT NULL,
    drop_timestamp bigint NOT NULL,
    purge_timestamp bigint NOT NULL,
    to_purge_timestamp bigint NOT NULL,
    last_update_timestamp bigint NOT NULL,
    properties jsonb DEFAULT '{}'::jsonb NOT NULL,
    internal_properties jsonb DEFAULT '{}'::jsonb NOT NULL,
    grant_records_version integer NOT NULL
);


--
-- Name: TABLE entities; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON TABLE polaris_schema.entities IS 'all the entities';


--
-- Name: COLUMN entities.realm_id; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.realm_id IS 'realm_id used for multi-tenancy';


--
-- Name: COLUMN entities.catalog_id; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.catalog_id IS 'catalog id';


--
-- Name: COLUMN entities.id; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.id IS 'entity id';


--
-- Name: COLUMN entities.parent_id; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.parent_id IS 'entity id of parent';


--
-- Name: COLUMN entities.name; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.name IS 'entity name';


--
-- Name: COLUMN entities.entity_version; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.entity_version IS 'version of the entity';


--
-- Name: COLUMN entities.type_code; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.type_code IS 'type code';


--
-- Name: COLUMN entities.sub_type_code; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.sub_type_code IS 'sub type of entity';


--
-- Name: COLUMN entities.create_timestamp; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.create_timestamp IS 'creation time of entity';


--
-- Name: COLUMN entities.drop_timestamp; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.drop_timestamp IS 'time of drop of entity';


--
-- Name: COLUMN entities.purge_timestamp; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.purge_timestamp IS 'time to start purging entity';


--
-- Name: COLUMN entities.last_update_timestamp; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.last_update_timestamp IS 'last time the entity is touched';


--
-- Name: COLUMN entities.properties; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.properties IS 'entities properties json';


--
-- Name: COLUMN entities.internal_properties; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.internal_properties IS 'entities internal properties json';


--
-- Name: COLUMN entities.grant_records_version; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.entities.grant_records_version IS 'the version of grant records change on the entity';


--
-- Name: grant_records; Type: TABLE; Schema: polaris_schema; Owner: -
--

CREATE TABLE polaris_schema.grant_records (
    realm_id text NOT NULL,
    securable_catalog_id bigint NOT NULL,
    securable_id bigint NOT NULL,
    grantee_catalog_id bigint NOT NULL,
    grantee_id bigint NOT NULL,
    privilege_code integer NOT NULL
);


--
-- Name: TABLE grant_records; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON TABLE polaris_schema.grant_records IS 'grant records for entities';


--
-- Name: COLUMN grant_records.securable_catalog_id; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.grant_records.securable_catalog_id IS 'catalog id of the securable';


--
-- Name: COLUMN grant_records.securable_id; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.grant_records.securable_id IS 'entity id of the securable';


--
-- Name: COLUMN grant_records.grantee_catalog_id; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.grant_records.grantee_catalog_id IS 'catalog id of the grantee';


--
-- Name: COLUMN grant_records.grantee_id; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.grant_records.grantee_id IS 'id of the grantee';


--
-- Name: COLUMN grant_records.privilege_code; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON COLUMN polaris_schema.grant_records.privilege_code IS 'privilege code';


--
-- Name: policy_mapping_record; Type: TABLE; Schema: polaris_schema; Owner: -
--

CREATE TABLE polaris_schema.policy_mapping_record (
    realm_id text NOT NULL,
    target_catalog_id bigint NOT NULL,
    target_id bigint NOT NULL,
    policy_type_code integer NOT NULL,
    policy_catalog_id bigint NOT NULL,
    policy_id bigint NOT NULL,
    parameters jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: principal_authentication_data; Type: TABLE; Schema: polaris_schema; Owner: -
--

CREATE TABLE polaris_schema.principal_authentication_data (
    realm_id text NOT NULL,
    principal_id bigint NOT NULL,
    principal_client_id character varying(255) NOT NULL,
    main_secret_hash character varying(255) NOT NULL,
    secondary_secret_hash character varying(255) NOT NULL,
    secret_salt character varying(255) NOT NULL
);


--
-- Name: TABLE principal_authentication_data; Type: COMMENT; Schema: polaris_schema; Owner: -
--

COMMENT ON TABLE polaris_schema.principal_authentication_data IS 'authentication data for client';


--
-- Name: iceberg_namespace_properties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.iceberg_namespace_properties (
    catalog_name character varying(255) NOT NULL,
    namespace character varying(255) NOT NULL,
    property_key character varying(255) NOT NULL,
    property_value character varying(1000) NOT NULL
);


--
-- Name: iceberg_tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.iceberg_tables (
    catalog_name character varying(255) NOT NULL,
    table_namespace character varying(255) NOT NULL,
    table_name character varying(255) NOT NULL,
    metadata_location character varying(1000),
    previous_metadata_location character varying(1000)
);


--
-- Data for Name: entities; Type: TABLE DATA; Schema: polaris_schema; Owner: -
--

COPY polaris_schema.entities (realm_id, catalog_id, id, parent_id, name, entity_version, type_code, sub_type_code, create_timestamp, drop_timestamp, purge_timestamp, to_purge_timestamp, last_update_timestamp, properties, internal_properties, grant_records_version) FROM stdin;
default-realm	0	8734345354152567023	0	root	1	2	0	1782951176152	0	0	0	1782951176152	{}	{"client_id": "root"}	2
default-realm	0	0	0	root_container	1	1	0	1782951176118	0	0	0	1782951176118	{}	{}	2
default-realm	0	8245429153548496894	0	service_admin	1	3	0	1782951176177	0	0	0	1782951176177	{}	{}	4
default-realm	8182124503447590638	688564548029562585	8182124503447590638	catalog_admin	1	5	0	1782951201726	0	0	0	1782951201726	{}	{}	4
default-realm	8182124503447590638	6315985942358786312	8182124503447590638	sales	1	6	0	1782981840185	0	0	0	1782981840185	{"location": "s3://lakehouse/wh/sales"}	{}	1
default-realm	0	8182124503447590638	0	lakehouse	2	4	0	1782951201387	0	0	0	1782991818968	{"s3.region": "us-east-1", "s3.endpoint": "http://minio:9000", "s3.access-key-id": "agentic-os-local", "s3.path-style-access": "true", "s3.secret-access-key": "agentic-os-local-secret", "default-base-location": "s3://lakehouse/wh", "table-default.s3.region": "us-east-1", "table-default.s3.endpoint": "http://minio:9000", "table-default.s3.path-style-access": "true"}	{"catalogType": "INTERNAL", "storage_configuration_info": "{\\"@type\\":\\"AwsStorageConfigurationInfo\\",\\"storageType\\":\\"S3\\",\\"allowedLocations\\":[\\"s3://lakehouse/wh/*\\",\\"s3://lakehouse/wh\\"],\\"roleARN\\":\\"arn:aws:iam::000000000000:role/polaris-lakehouse\\",\\"fileIoImplClassName\\":\\"org.apache.iceberg.aws.s3.S3FileIO\\"}"}	3
default-realm	8182124503447590638	5857677938319904555	6315985942358786312	gold_northpeak_commerce	4	7	2	1783201113535	0	0	0	1783201553232	{"location": "s3://lakehouse/wh/sales/gold_northpeak_commerce"}	{"parent-namespace": "sales", "metadata-location": "s3://lakehouse/wh/sales/gold_northpeak_commerce/metadata/00003-3b441246-019b-4d13-992e-050be74ad6d2.metadata.json"}	1
\.


--
-- Data for Name: grant_records; Type: TABLE DATA; Schema: polaris_schema; Owner: -
--

COPY polaris_schema.grant_records (realm_id, securable_catalog_id, securable_id, grantee_catalog_id, grantee_id, privilege_code) FROM stdin;
default-realm	0	8245429153548496894	0	8734345354152567023	4
default-realm	0	0	0	8245429153548496894	1
default-realm	0	8182124503447590638	8182124503447590638	688564548029562585	2
default-realm	0	8182124503447590638	8182124503447590638	688564548029562585	31
default-realm	8182124503447590638	688564548029562585	0	8245429153548496894	3
\.


--
-- Data for Name: policy_mapping_record; Type: TABLE DATA; Schema: polaris_schema; Owner: -
--

COPY polaris_schema.policy_mapping_record (realm_id, target_catalog_id, target_id, policy_type_code, policy_catalog_id, policy_id, parameters) FROM stdin;
\.


--
-- Data for Name: principal_authentication_data; Type: TABLE DATA; Schema: polaris_schema; Owner: -
--

COPY polaris_schema.principal_authentication_data (realm_id, principal_id, principal_client_id, main_secret_hash, secondary_secret_hash, secret_salt) FROM stdin;
default-realm	8734345354152567023	root	16913eb81277d9d518c6af275bbc88b48caad327875f447f30509403e62ec023	16913eb81277d9d518c6af275bbc88b48caad327875f447f30509403e62ec023	9c3cb3e52fa2b52f
\.


--
-- Data for Name: iceberg_namespace_properties; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.iceberg_namespace_properties (catalog_name, namespace, property_key, property_value) FROM stdin;
\.


--
-- Data for Name: iceberg_tables; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.iceberg_tables (catalog_name, table_namespace, table_name, metadata_location, previous_metadata_location) FROM stdin;
\.


--
-- Name: entities constraint_name; Type: CONSTRAINT; Schema: polaris_schema; Owner: -
--

ALTER TABLE ONLY polaris_schema.entities
    ADD CONSTRAINT constraint_name UNIQUE (realm_id, catalog_id, parent_id, type_code, name);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: polaris_schema; Owner: -
--

ALTER TABLE ONLY polaris_schema.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (realm_id, id);


--
-- Name: grant_records grant_records_pkey; Type: CONSTRAINT; Schema: polaris_schema; Owner: -
--

ALTER TABLE ONLY polaris_schema.grant_records
    ADD CONSTRAINT grant_records_pkey PRIMARY KEY (realm_id, securable_catalog_id, securable_id, grantee_catalog_id, grantee_id, privilege_code);


--
-- Name: policy_mapping_record policy_mapping_record_pkey; Type: CONSTRAINT; Schema: polaris_schema; Owner: -
--

ALTER TABLE ONLY polaris_schema.policy_mapping_record
    ADD CONSTRAINT policy_mapping_record_pkey PRIMARY KEY (realm_id, target_catalog_id, target_id, policy_type_code, policy_catalog_id, policy_id);


--
-- Name: principal_authentication_data principal_authentication_data_pkey; Type: CONSTRAINT; Schema: polaris_schema; Owner: -
--

ALTER TABLE ONLY polaris_schema.principal_authentication_data
    ADD CONSTRAINT principal_authentication_data_pkey PRIMARY KEY (realm_id, principal_client_id);


--
-- Name: iceberg_namespace_properties iceberg_namespace_properties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.iceberg_namespace_properties
    ADD CONSTRAINT iceberg_namespace_properties_pkey PRIMARY KEY (catalog_name, namespace, property_key);


--
-- Name: iceberg_tables iceberg_tables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.iceberg_tables
    ADD CONSTRAINT iceberg_tables_pkey PRIMARY KEY (catalog_name, table_namespace, table_name);


--
-- Name: idx_entities; Type: INDEX; Schema: polaris_schema; Owner: -
--

CREATE INDEX idx_entities ON polaris_schema.entities USING btree (realm_id, catalog_id, id);


--
-- Name: idx_policy_mapping_record; Type: INDEX; Schema: polaris_schema; Owner: -
--

CREATE INDEX idx_policy_mapping_record ON polaris_schema.policy_mapping_record USING btree (realm_id, policy_type_code, policy_catalog_id, policy_id, target_catalog_id, target_id);


--
-- PostgreSQL database dump complete
--

\unrestrict 2h15avFwMmFfrFq3j1ttjAm7YqyYDjd9znZsO1tx8VqMea7HGAzdcdgvEHZ8hN9

