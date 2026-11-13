function Clear-ReadonlyEnvironment {
    param([Parameter(Mandatory)][System.Collections.Specialized.StringDictionary]$Environment)
    # Preserve the readonly guardian's isolation from interactive writer/DMS settings.
    foreach ($key in @($Environment.Keys)) {
        if ($key -like 'NC_DB_*' -or $key -like 'NC_TEST_DB_*' -or $key -like 'DMS_*' -or $key -like 'WAREHOUSE_*' -or
            $key -in @('DATA_SOURCE', 'LISTEN_HOST', 'PORT', 'RUNTIME_DATA_DIR', 'DB_DUAL_WRITE', 'NODE_OPTIONS')) {
            $Environment.Remove($key)
        }
    }
}
