package dev.geo.admin.generator;

import dev.geo.admin.common.exception.ServiceException;
import dev.geo.admin.generator.mapper.GenTableMapper;
import dev.geo.admin.generator.model.GenTable;
import dev.geo.admin.generator.model.GenTableColumn;
import dev.geo.admin.generator.service.GenTableServiceImpl;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.*;

class GenTableOutputTest {
    @TempDir
    Path outputRoot;

    @Test
    void previewZipAndDiskUseTheSameRenderedFiles() throws IOException {
        GenTable table = table("demo_item", "Demo Item");
        var generator = generator(Map.of(table.getTableName(), table));

        Map<String, String> preview = generator.previewCode(table.getId());
        Map<String, String> zipped = unzip(generator.downloadCode(table.getTableName()));
        generator.generatorCode(table.getTableName());

        assertTrue(preview.size() > 5);
        assertEquals(preview.keySet(), zipped.keySet());
        for (Map.Entry<String, String> file : preview.entrySet()) {
            String onDisk = Files.readString(outputRoot.resolve(file.getKey()), StandardCharsets.UTF_8);
            assertEquals(withoutGenerationTime(file.getValue()), withoutGenerationTime(zipped.get(file.getKey())));
            assertEquals(withoutGenerationTime(file.getValue()), withoutGenerationTime(onDisk));
        }
    }

    @Test
    void batchDownloadRejectsDifferentContentAtTheSameFileName() {
        GenTable first = table("demo_item", "First item");
        GenTable second = table("demo_other", "Second item");
        var generator = generator(Map.of(first.getTableName(), first, second.getTableName(), second));

        ServiceException error = assertThrows(ServiceException.class,
                () -> generator.downloadCode(new String[]{first.getTableName(), second.getTableName()}));
        assertTrue(error.getMessage().contains("生成文件名冲突"));
    }

    @Test
    void missingPrimaryKeyStopsEveryOutputBeforeWriting() throws IOException {
        GenTable table = table("demo_item", "Demo Item");
        table.getColumns().get(0).setIsPk("0");
        var generator = generator(Map.of(table.getTableName(), table));

        assertThrows(ServiceException.class, () -> generator.previewCode(table.getId()));
        assertThrows(ServiceException.class, () -> generator.downloadCode(table.getTableName()));
        assertThrows(ServiceException.class, () -> generator.generatorCode(table.getTableName()));
        try (var files = Files.list(outputRoot)) {
            assertEquals(0, files.count());
        }
    }

    private GenTable table(String name, String functionName) {
        var table = new GenTable();
        table.setId(1L);
        table.setTableName(name);
        table.setTableComment(functionName);
        table.setClassName("DemoItem");
        table.setBusinessName("item");
        table.setModuleName("demo");
        table.setPackageName("dev.geo.demo");
        table.setTplCategory("crud");
        table.setFunctionName(functionName);
        table.setFunctionAuthor("test");
        table.setOptions("{}");
        table.setGenPath(outputRoot.toString());

        var id = new GenTableColumn();
        id.setColumnName("id");
        id.setColumnComment("ID");
        id.setColumnType("bigint");
        id.setJavaField("id");
        id.setJavaType("Long");
        id.setIsPk("1");
        id.setIsIncrement("1");
        id.setIsRequired("1");
        id.setIsInsert("1");
        id.setIsEdit("0");
        id.setIsList("1");
        id.setIsQuery("1");
        id.setQueryType("EQ");
        id.setHtmlType("input");
        table.setColumns(List.of(id));
        return table;
    }

    private static GenTableServiceImpl generator(Map<String, GenTable> tables) {
        GenTableMapper mapper = (GenTableMapper) Proxy.newProxyInstance(
                GenTableMapper.class.getClassLoader(), new Class<?>[]{GenTableMapper.class},
                (proxy, method, args) -> switch (method.getName()) {
                    case "selectGenTableById" -> tables.values().stream()
                            .filter(table -> table.getId().equals(args[0])).findFirst().orElse(null);
                    case "selectGenTableByName" -> tables.get(args[0]);
                    default -> throw new UnsupportedOperationException(method.getName());
                });
        return new GenTableServiceImpl(mapper, null);
    }

    private static Map<String, String> unzip(byte[] content) throws IOException {
        Map<String, String> files = new LinkedHashMap<>();
        try (var zip = new ZipInputStream(new ByteArrayInputStream(content), StandardCharsets.UTF_8)) {
            for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                files.put(entry.getName(), new String(zip.readAllBytes(), StandardCharsets.UTF_8));
                zip.closeEntry();
            }
        }
        return files;
    }

    private static String withoutGenerationTime(String content) {
        return content.replaceAll("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}", "<generated-at>");
    }
}
